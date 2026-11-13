import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { assertKimiCodeCredentialCompatible } from './provider-compatibility.mjs';

const directory = resolve(process.env.RESPROUT_CONFIG_DIR ?? '.resprout');
const file = resolve(directory, 'providers.json');
const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro'];
const catalog = createModels();
catalog.setProvider(deepseekProvider());
const deepseekContexts = Object.fromEntries(catalog.getModels('deepseek').map(model => [model.id, model.contextWindow]));
const deepseekInputs = Object.fromEntries(catalog.getModels('deepseek').map(model => [model.id, model.input ?? ['text']]));
let state = { providers: [], active: null, search: null };

function environmentProvider() {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  return {
    id: 'environment-deepseek',
    name: 'DeepSeek（环境变量）',
    kind: 'deepseek',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    modelIds: deepseekModels,
    apiKey: process.env.DEEPSEEK_API_KEY,
    environment: true,
  };
}

function allProviders() {
  return [...state.providers, ...(environmentProvider() ? [environmentProvider()] : [])];
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    modelIds: provider.modelIds,
    modelContexts: {
      ...(provider.kind === 'deepseek' ? deepseekContexts : {}),
      ...(provider.modelContexts ?? {}),
    },
    modelInputs: {
      ...(provider.kind === 'deepseek' ? deepseekInputs : {}),
      ...(provider.modelInputs ?? {}),
    },
    hasApiKey: Boolean(provider.apiKey),
    environment: Boolean(provider.environment),
  };
}

export function providerState() {
  const providers = allProviders();
  let selected = providers.find(provider => provider.id === state.active?.providerId) ?? providers[0] ?? null;
  if (selected?.environment && process.env.DEEPSEEK_MODEL && !state.active) {
    return {
      providers: providers.map(publicProvider),
      active: { providerId: selected.id, modelId: process.env.DEEPSEEK_MODEL },
    };
  }
  const modelId = selected?.modelIds.includes(state.active?.modelId) ? state.active.modelId : selected?.modelIds[0];
  return {
    providers: providers.map(publicProvider),
    active: selected ? { providerId: selected.id, modelId } : null,
  };
}

export function activeProvider() {
  const current = providerState();
  if (!current.active) return null;
  const provider = allProviders().find(item => item.id === current.active.providerId);
  return provider ? { provider, modelId: current.active.modelId } : null;
}

export function resolveProvider(selection) {
  if (!selection?.providerId && !selection?.modelId) return activeProvider();
  const provider = allProviders().find(item => item.id === selection.providerId);
  const modelId = String(selection.modelId ?? '');
  if (!provider || !provider.modelIds.includes(modelId)) throw new Error('供应商或模型无效');
  return { provider, modelId };
}

async function persist() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, 'providers.json.tmp');
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadProviders() {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(saved.providers)) state.providers = saved.providers;
    if (saved.active) state.active = saved.active;
    if (saved.search?.apiKey) state.search = { apiKey: saved.search.apiKey, baseUrl: saved.search.baseUrl };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function saveProvider(input) {
  const name = String(input.name ?? '').trim();
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const kind = input.kind === 'deepseek' ? 'deepseek' : 'openai';
  const modelIds = [...new Set((input.modelIds ?? []).map(id => String(id).trim()).filter(Boolean))];
  const url = new URL(baseUrl);
  if (!name || !['http:', 'https:'].includes(url.protocol) || modelIds.length === 0) {
    throw new Error('名称、Base URL 和至少一个模型 ID 不能为空');
  }

  const existing = state.providers.find(provider => provider.id === input.id);
  const apiKey = String(input.apiKey ?? '').trim() || existing?.apiKey;
  if (!apiKey) throw new Error('API Key 不能为空');
  assertKimiCodeCredentialCompatible({ apiKey, baseUrl });
  const contextInput = input.modelContexts === undefined ? (existing?.modelContexts ?? {}) : input.modelContexts;
  const modelContexts = Object.fromEntries(modelIds.flatMap(id => {
    const value = Number(contextInput[id]);
    return Number.isFinite(value) && value > 0 ? [[id, Math.round(value)]] : [];
  }));
  const inputsInput = input.modelInputs === undefined ? (existing?.modelInputs ?? {}) : input.modelInputs;
  const modelInputs = Object.fromEntries(modelIds.flatMap(id => {
    const values = Array.isArray(inputsInput[id]) ? [...new Set(inputsInput[id].filter(value => value === 'text' || value === 'image'))] : [];
    return values.length ? [[id, values]] : [];
  }));
  const provider = {
    id: existing?.id ?? randomUUID(),
    name,
    kind,
    baseUrl,
    modelIds,
    modelContexts,
    modelInputs,
    apiKey,
  };
  if (existing) {
    state.providers = state.providers.map(item => item.id === existing.id ? provider : item);
  } else {
    state.providers.push(provider);
  }
  if (input.activate !== false || state.active?.providerId === provider.id) {
    state.active = { providerId: provider.id, modelId: modelIds[0] };
  }
  await persist();
  return providerState();
}

export async function deleteProvider(id) {
  state.providers = state.providers.filter(provider => provider.id !== id);
  if (state.active?.providerId === id) state.active = null;
  await persist();
  return providerState();
}

export async function activateProvider(input) {
  const provider = allProviders().find(item => item.id === input.providerId);
  if (!provider || !provider.modelIds.includes(input.modelId)) throw new Error('供应商或模型无效');
  state.active = { providerId: provider.id, modelId: input.modelId };
  await persist();
  return providerState();
}

export function resolveProviderAccess(input = {}) {
  const existing = allProviders().find(provider => provider.id === input.providerId);
  const apiKey = String(input.apiKey ?? '').trim() || existing?.apiKey;
  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!apiKey) throw new Error('请先填写 API Key');
  if (!baseUrl) throw new Error('请先填写 Base URL');
  assertKimiCodeCredentialCompatible({ apiKey, baseUrl });
  return {
    apiKey,
    baseUrl,
    kind: existing?.kind ?? (input.kind === 'deepseek' ? 'deepseek' : 'openai'),
  };
}

export function resolveSearchAccess() {
  const providers = allProviders();
  const deepseek = providers.find(provider => provider.kind === 'deepseek' && provider.apiKey);
  if (deepseek) return { apiKey: deepseek.apiKey, baseUrl: deepseek.baseUrl, source: 'provider' };
  if (state.search?.apiKey) {
    return { apiKey: state.search.apiKey, baseUrl: state.search.baseUrl, source: 'dedicated' };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      source: 'environment',
    };
  }
  return null;
}

export function searchConfigState() {
  const access = resolveSearchAccess();
  return { available: Boolean(access), source: access?.source ?? null };
}

export async function saveSearchAccess(input = {}) {
  const apiKey = String(input.apiKey ?? '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error('Base URL 无效');
  state.search = { apiKey, baseUrl };
  await persist();
  return searchConfigState();
}

export async function clearSearchAccess() {
  state.search = null;
  await persist();
  return searchConfigState();
}
