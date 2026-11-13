import { createHash } from 'node:crypto';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import type { Model, ModelInputModality, MutableModels } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createModelsStore } from './models-store.ts';

const NON_CHAT_MODEL = /(?:^|[-_/:])(embedding|embeddings|embed|rerank|rank|whisper|tts|speech|transcribe|transcription|moderation|dall-e|image|images|imagen|video|veo|clip)(?:$|[-_/:])/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ModelDiscoveryInput {
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface DiscoveredModels {
  models: string[];
  contexts: Record<string, number>;
  inputs: Record<string, ModelInputModality[]>;
  filteredCount: number;
}

export type FetchImplementation = typeof fetch;

interface NormalizedInput {
  baseUrl: string;
  apiKey: string;
}

interface Catalog {
  models: Model<'openai-completions'>[];
  contexts: Record<string, number>;
  inputs: Record<string, ModelInputModality[]>;
  filteredCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelInputModality(value: unknown): value is ModelInputModality {
  return value === 'text' || value === 'image';
}

function errorProperty(error: unknown, key: 'name' | 'message'): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[key];
  return typeof value === 'string' ? value : undefined;
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('模型列表响应过大');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function providerError(status: number, text: string): string {
  let detail = '';
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) {
      const error = isRecord(value.error) ? value.error : null;
      const message = error?.message ?? value.message;
      detail = String(message ?? '').trim().slice(0, 240);
    }
  } catch {}
  if (status === 401 || status === 403) return `API Key 无效或没有模型列表权限（HTTP ${status}）${detail ? `：${detail}` : ''}`;
  if (status === 404) return '该供应商没有提供标准模型列表接口，请手动输入模型 ID';
  return `获取模型列表失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

function entryId(item: unknown): string | null {
  if (typeof item === 'string') return item;
  if (isRecord(item) && typeof item.id === 'string') return item.id;
  return null;
}

function modelEntries(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.models)) return value.models;
  return null;
}

function normalizeInput(input: ModelDiscoveryInput): NormalizedInput {
  const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '');
  const endpoint = new URL(`${baseUrl}/models`);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Base URL 必须使用 HTTP 或 HTTPS');
  const apiKey = String(input.apiKey ?? '').trim();
  if (!apiKey) throw new Error('请先填写 API Key');
  return { baseUrl, apiKey };
}

async function fetchCatalog(
  input: NormalizedInput,
  providerId: string,
  signal: AbortSignal,
  fetchImpl: FetchImplementation,
): Promise<Catalog> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(`${input.baseUrl}/models`), {
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
  } catch (error) {
    if (errorProperty(error, 'name') === 'TimeoutError' || errorProperty(error, 'name') === 'AbortError') {
      throw new Error('连接模型服务超时，请检查 Base URL 和网络');
    }
    throw new Error(`无法连接模型服务：${errorProperty(error, 'message') ?? String(error)}`);
  }
  const text = await responseText(response);
  if (!response.ok) throw new Error(providerError(response.status, text));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('供应商返回的模型列表不是有效 JSON');
  }
  const entries = modelEntries(value);
  if (!entries) throw new Error('无法识别供应商返回的模型列表格式');
  const allIds = [...new Set(
    entries
      .map(entryId)
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim()),
  )];
  const models = allIds.filter(id => !NON_CHAT_MODEL.test(id)).sort((a, b) => a.localeCompare(b));
  const contexts: Record<string, number> = {};
  for (const item of entries) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const id = item.id;
    const limits = isRecord(item.limits) ? item.limits : {};
    const candidates: unknown[] = [
      item.context_length,
      item.context_window,
      item.contextWindow,
      item.max_context_tokens,
      item.max_input_tokens,
      item.input_token_limit,
      limits.context_window,
      limits.max_input_tokens,
    ];
    const contextWindow = candidates.map(Number).find(candidate => Number.isFinite(candidate) && candidate > 0);
    if (contextWindow) contexts[id] = Math.round(contextWindow);
  }
  const inputs: Record<string, ModelInputModality[]> = {};
  for (const item of entries) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const id = item.id;
    const capabilities = item.input ?? item.modalities ?? (isRecord(item.capabilities) ? item.capabilities.input : undefined);
    if (!Array.isArray(capabilities)) continue;
    const values = [...new Set(capabilities.filter(isModelInputModality))];
    if (values.length) inputs[id] = values;
  }
  const modelList = models.map(id => ({
    id,
    name: id,
    api: 'openai-completions' as const,
    provider: providerId,
    baseUrl: input.baseUrl,
    reasoning: false,
    input: inputs[id] ?? ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contexts[id] ?? 128000,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  }));
  return {
    models: modelList,
    contexts,
    inputs,
    filteredCount: allIds.length - models.length,
  };
}

export async function discoverModels(input: ModelDiscoveryInput, fetchImpl: FetchImplementation = fetch): Promise<DiscoveredModels> {
  const normalized = normalizeInput(input);
  const providerId = `discovery-${createHash('sha256').update(normalized.baseUrl).digest('hex').slice(0, 16)}`;
  let catalog: Catalog | undefined;
  const provider = createProvider({
    id: providerId,
    name: 'Model discovery',
    baseUrl: normalized.baseUrl,
    auth: {
      apiKey: {
        name: 'API Key',
        resolve: async () => ({ auth: { apiKey: normalized.apiKey } }),
      },
    },
    models: [],
    fetchModels: async ({ signal }) => {
      catalog = await fetchCatalog(normalized, providerId, signal, fetchImpl);
      return catalog.models;
    },
    api: openAICompletionsApi(),
  });
  const models: MutableModels = createModels({ modelsStore: createModelsStore() });
  models.setProvider(provider);
  const refreshed = await models.refresh({ providers: [providerId], force: true });
  if (refreshed.aborted) throw new Error('模型列表刷新已取消');
  const refreshError = refreshed.errors.get(providerId);
  if (refreshError) throw refreshError;
  if (!catalog) throw new Error('模型列表未完成刷新');
  return {
    models: models.getModels(providerId).map(model => model.id).sort((a, b) => a.localeCompare(b)),
    contexts: catalog.contexts,
    inputs: catalog.inputs,
    filteredCount: catalog.filteredCount,
  };
}
