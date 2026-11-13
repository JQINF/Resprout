import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import type { ModelInputModality, MutableModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';
import { assertKimiCodeCredentialCompatible } from './provider-compatibility.ts';

export type ProviderKind = 'deepseek' | 'openai';
export type ModelContexts = Record<string, number>;
export type ModelInputs = Record<string, ModelInputModality[]>;
export type ModelInputStatus = Record<string, 'verified'>;
export type SearchAccessSource = 'provider' | 'dedicated' | 'environment';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelIds: string[];
  modelContexts?: ModelContexts;
  modelInputs?: ModelInputs;
  modelInputStatus?: ModelInputStatus;
  apiKey: string;
  environment?: boolean;
}

export interface PublicProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelIds: string[];
  modelContexts: ModelContexts;
  modelInputs: ModelInputs;
  modelInputStatus: ModelInputStatus;
  hasApiKey: boolean;
  environment: boolean;
}

export interface ActiveProviderSelection {
  providerId: string;
  modelId: string;
}

export interface ProviderState {
  providers: PublicProvider[];
  active: ActiveProviderSelection | null;
}

export interface ProviderSelection {
  providerId?: string;
  modelId?: string;
}

export interface ResolvedProvider {
  provider: ProviderConfig;
  modelId: string;
}

export interface ProviderAccess {
  apiKey: string;
  baseUrl: string;
  kind: ProviderKind;
}

export interface ProviderAccessInput {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  kind?: string;
}

export interface SaveProviderInput {
  id?: string;
  name?: string;
  kind?: string;
  baseUrl?: string;
  modelIds?: readonly string[];
  modelContexts?: Readonly<Record<string, number | string>>;
  modelInputs?: Readonly<Record<string, readonly string[]>>;
  apiKey?: string;
  activate?: boolean;
}

export interface ActivateProviderInput {
  providerId?: string;
  modelId?: string;
}

export interface StoredSearchAccess {
  apiKey: string;
  baseUrl: string;
}

export interface StoredProviderState {
  providers: ProviderConfig[];
  active: ActiveProviderSelection | null;
  search: StoredSearchAccess | null;
}

export interface SearchAccess {
  apiKey: string;
  baseUrl: string;
  source: SearchAccessSource;
}

export interface SearchConfigState {
  available: boolean;
  source: SearchAccessSource | null;
}

export interface SaveSearchAccessInput {
  apiKey?: string;
  baseUrl?: string;
}

const directory = resolve(process.env.RESPROUT_CONFIG_DIR ?? '.resprout');
const file = resolve(directory, 'providers.json');
const deepseekModels = ['deepseek-flash', 'deepseek-v4-pro'];
const catalog: MutableModels = createModels();
catalog.setProvider(deepseekProvider());
const deepseekContexts: ModelContexts = Object.fromEntries(
  catalog.getModels('deepseek').map(model => [model.id, model.contextWindow]),
);
const deepseekInputs: ModelInputs = Object.fromEntries(
  catalog.getModels('deepseek').map((model): [string, ModelInputModality[]] => [model.id, model.input ?? ['text']]),
);
const kimiCatalog: MutableModels = createModels();
kimiCatalog.setProvider(kimiCodingProvider());
const kimiInputs: ModelInputs = Object.fromEntries(
  kimiCatalog.getModels('kimi-coding').map((model): [string, ModelInputModality[]] => [model.id, model.input ?? ['text']]),
);
let state: StoredProviderState = { providers: [], active: null, search: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelInputModality(value: unknown): value is ModelInputModality {
  return value === 'text' || value === 'image';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isNumberRecord(value: unknown): value is ModelContexts {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'number');
}

function isModelInputs(value: unknown): value is ModelInputs {
  return isRecord(value) && Object.values(value).every(item => Array.isArray(item) && item.every(isModelInputModality));
}

function isModelInputStatus(value: unknown): value is ModelInputStatus {
  return isRecord(value) && Object.values(value).every(item => item === 'verified');
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && (value.kind === 'deepseek' || value.kind === 'openai')
    && typeof value.baseUrl === 'string'
    && isStringArray(value.modelIds)
    && typeof value.apiKey === 'string'
    && (value.modelContexts === undefined || isNumberRecord(value.modelContexts))
    && (value.modelInputs === undefined || isModelInputs(value.modelInputs))
    && (value.modelInputStatus === undefined || isModelInputStatus(value.modelInputStatus))
    && (value.environment === undefined || typeof value.environment === 'boolean');
}

function isActiveProviderSelection(value: unknown): value is ActiveProviderSelection {
  return isRecord(value) && typeof value.providerId === 'string' && typeof value.modelId === 'string';
}

function isStoredSearchAccess(value: unknown): value is StoredSearchAccess {
  return isRecord(value) && typeof value.apiKey === 'string' && typeof value.baseUrl === 'string';
}

function environmentProvider(): ProviderConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'environment-deepseek',
    name: 'DeepSeek（环境变量）',
    kind: 'deepseek',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    modelIds: deepseekModels,
    apiKey,
    environment: true,
  };
}

function allProviders(): ProviderConfig[] {
  const environment = environmentProvider();
  return environment ? [...state.providers, environment] : [...state.providers];
}

export function knownProviderInputs(provider: ProviderConfig): ModelInputs | null {
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase();
    return hostname === 'api.kimi.com' || hostname === 'api.kimi.ai' ? kimiInputs : null;
  } catch {
    return null;
  }
}

export function providerModelInputs(provider: ProviderConfig, modelId: string): ModelInputModality[] {
  return knownProviderInputs(provider)?.[modelId]
    ?? provider.modelInputs?.[modelId]
    ?? (provider.kind === 'deepseek' ? catalog.getModel('deepseek', modelId)?.input ?? ['text'] : ['text']);
}

function publicProvider(provider: ProviderConfig): PublicProvider {
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
      ...(knownProviderInputs(provider) ?? {}),
      ...(provider.kind === 'deepseek' ? deepseekInputs : {}),
      ...(provider.modelInputs ?? {}),
    },
    modelInputStatus: provider.modelInputStatus ?? {},
    hasApiKey: Boolean(provider.apiKey),
    environment: Boolean(provider.environment),
  };
}

export function providerState(): ProviderState {
  const providers = allProviders();
  const selected = providers.find(provider => provider.id === state.active?.providerId) ?? providers[0] ?? null;
  const environmentModelId = process.env.DEEPSEEK_MODEL;
  if (selected?.environment && environmentModelId && !state.active) {
    return {
      providers: providers.map(publicProvider),
      active: { providerId: selected.id, modelId: environmentModelId },
    };
  }
  if (!selected) return { providers: providers.map(publicProvider), active: null };
  const modelId = state.active && selected.modelIds.includes(state.active.modelId)
    ? state.active.modelId
    : selected.modelIds[0];
  return {
    providers: providers.map(publicProvider),
    active: { providerId: selected.id, modelId },
  };
}

export function activeProvider(): ResolvedProvider | null {
  const current = providerState();
  const active = current.active;
  if (!active) return null;
  const provider = allProviders().find(item => item.id === active.providerId);
  return provider ? { provider, modelId: active.modelId } : null;
}

export function resolveProvider(selection?: ProviderSelection | null): ResolvedProvider | null {
  if (!selection) return activeProvider();
  if (!selection.providerId && !selection.modelId) return activeProvider();
  const provider = allProviders().find(item => item.id === selection.providerId);
  const modelId = String(selection.modelId ?? '');
  if (!provider || !provider.modelIds.includes(modelId)) throw new Error('供应商或模型无效');
  return { provider, modelId };
}

async function persist(): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, 'providers.json.tmp');
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadProviders(): Promise<void> {
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(saved)) return;
    if (Array.isArray(saved.providers)) state.providers = saved.providers.filter(isProviderConfig);
    if (isActiveProviderSelection(saved.active)) state.active = saved.active;
    if (isStoredSearchAccess(saved.search) && saved.search.apiKey) {
      state.search = { apiKey: saved.search.apiKey, baseUrl: saved.search.baseUrl };
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export async function saveProvider(input: SaveProviderInput): Promise<ProviderState> {
  const name = String(input.name ?? '').trim();
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const kind: ProviderKind = input.kind === 'deepseek' ? 'deepseek' : 'openai';
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
  const modelContexts: ModelContexts = Object.fromEntries(modelIds.flatMap(id => {
    const value = Number(contextInput[id]);
    return Number.isFinite(value) && value > 0 ? [[id, Math.round(value)] as const] : [];
  }));
  const inputsInput = input.modelInputs === undefined ? (existing?.modelInputs ?? {}) : input.modelInputs;
  const modelInputs: ModelInputs = Object.fromEntries(modelIds.flatMap(id => {
    const configured = inputsInput[id];
    const values = Array.isArray(configured) ? [...new Set(configured.filter(isModelInputModality))] : [];
    return values.length ? [[id, values] as const] : [];
  }));
  const provider: ProviderConfig = {
    id: existing?.id ?? randomUUID(),
    name,
    kind,
    baseUrl,
    modelIds,
    modelContexts,
    modelInputs,
    modelInputStatus: baseUrl === existing?.baseUrl ? existing.modelInputStatus : {},
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

export async function setModelInputs(providerId: string, modelId: string, inputs: readonly ModelInputModality[]): Promise<void> {
  const provider = state.providers.find(item => item.id === providerId);
  if (!provider) return;
  provider.modelInputs = { ...provider.modelInputs, [modelId]: [...inputs] };
  provider.modelInputStatus = { ...provider.modelInputStatus, [modelId]: 'verified' };
  await persist();
}

export async function deleteProvider(id: string): Promise<ProviderState> {
  state.providers = state.providers.filter(provider => provider.id !== id);
  if (state.active?.providerId === id) state.active = null;
  await persist();
  return providerState();
}

export async function activateProvider(input: ActivateProviderInput): Promise<ProviderState> {
  const provider = allProviders().find(item => item.id === input.providerId);
  const modelId = input.modelId;
  if (!provider || typeof modelId !== 'string' || !provider.modelIds.includes(modelId)) throw new Error('供应商或模型无效');
  state.active = { providerId: provider.id, modelId };
  await persist();
  return providerState();
}

export function resolveProviderAccess(input: ProviderAccessInput = {}): ProviderAccess {
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

export function resolveSearchAccess(): SearchAccess | null {
  const providers = allProviders();
  const deepseek = providers.find(provider => provider.kind === 'deepseek' && provider.apiKey);
  if (deepseek) return { apiKey: deepseek.apiKey, baseUrl: deepseek.baseUrl, source: 'provider' };
  const search = state.search;
  if (search?.apiKey) {
    return { apiKey: search.apiKey, baseUrl: search.baseUrl, source: 'dedicated' };
  }
  const environmentApiKey = process.env.DEEPSEEK_API_KEY;
  if (environmentApiKey) {
    return {
      apiKey: environmentApiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      source: 'environment',
    };
  }
  return null;
}

export function searchConfigState(): SearchConfigState {
  const access = resolveSearchAccess();
  return { available: Boolean(access), source: access?.source ?? null };
}

export async function saveSearchAccess(input: SaveSearchAccessInput = {}): Promise<SearchConfigState> {
  const apiKey = String(input.apiKey ?? '').trim();
  if (!apiKey) throw new Error('API Key 不能为空');
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
  if (!['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error('Base URL 无效');
  state.search = { apiKey, baseUrl };
  await persist();
  return searchConfigState();
}

export async function clearSearchAccess(): Promise<SearchConfigState> {
  state.search = null;
  await persist();
  return searchConfigState();
}
