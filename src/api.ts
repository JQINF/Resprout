export type ProviderKind = 'deepseek' | 'openai';
export type ModelInput = 'text' | 'image';
export type ModelContexts = Record<string, number>;
export type ModelInputs = Record<string, ModelInput[]>;
export type ModelInputStatus = Record<string, 'verified'>;

export interface PublicProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  modelIds: string[];
  modelContexts: ModelContexts;
  modelInputs: ModelInputs;
  modelInputStatus?: ModelInputStatus;
  hasApiKey: boolean;
  environment: boolean;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface ProviderState {
  providers: PublicProvider[];
  active: ModelSelection | null;
}

export interface ProviderModelDiscovery {
  models: string[];
  contexts: ModelContexts;
  inputs: ModelInputs;
  notice: string;
}

export type SearchSource = 'provider' | 'dedicated' | 'environment';

export interface SearchConfig {
  available: boolean;
  source: SearchSource | null;
}

export interface DiscoverProviderModelsInput {
  providerId?: string;
  kind?: string;
  baseUrl: string;
  apiKey?: string;
}

export interface SaveProviderInput {
  id?: string;
  name: string;
  kind?: string;
  baseUrl: string;
  modelIds: string[];
  modelContexts?: ModelContexts;
  modelInputs?: ModelInputs;
  apiKey?: string;
  activate?: boolean;
}

export interface SaveSearchConfigInput {
  apiKey?: string;
  baseUrl?: string;
  clear?: boolean;
}

export type ChatImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ChatTextBlock {
  type: 'text';
  text: string;
}

export interface ChatImageBlock {
  type: 'image';
  data: string;
  mimeType: ChatImageMimeType;
}

export type ChatContentBlock = ChatTextBlock | ChatImageBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatContentBlock[];
}

export interface OutgoingChatImageBlock {
  type: 'image';
  data: string;
  mimeType: string;
}

export type OutgoingChatContentBlock = ChatTextBlock | OutgoingChatImageBlock;

export interface OutgoingChatMessage {
  role: string;
  content: string | OutgoingChatContentBlock[];
}

export interface ChatModelRef {
  providerId?: string | null;
  modelId?: string | null;
}

export interface ChatUsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  totalFromProvider?: boolean;
}

export interface ChatUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: ChatUsageCost;
}

export interface ChatResult {
  text: string;
  thinking?: string;
}

export interface ChatTextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface ChatThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

export interface ChatToolCallEvent {
  type: 'tool_call';
  name: string;
  arguments: unknown;
}

export interface ChatDoneEvent {
  type: 'done';
  stopReason?: string;
  result?: ChatResult;
  usage?: ChatUsage;
}

export interface ChatErrorEvent {
  type: 'error';
  error: string;
}

export type ChatStreamEvent =
  | ChatTextDeltaEvent
  | ChatThinkingDeltaEvent
  | ChatToolCallEvent
  | ChatDoneEvent
  | ChatErrorEvent;

export interface ChatOptions {
  sessionId?: string;
  requestId?: string;
  durable?: boolean;
  parentRequestId?: string;
  conversationContent?: string;
  quickAction?: boolean;
  webSearch?: boolean;
  purpose?: string;
  structuredOutput?: boolean;
  schema?: Record<string, unknown>;
  schemaName?: string;
  temperature?: number;
}

export interface RunSnapshot {
  requestId: string;
  status: 'running' | 'done' | 'failed';
  text: string;
  thinking: string;
  stopReason: string | null;
  usage: ChatUsage | null;
  error: string;
}

export interface ReconcileRunsResponse {
  runs: RunSnapshot[];
}

interface ChatRequestBody {
  messages: readonly OutgoingChatMessage[];
  providerId?: string | null;
  modelId?: string | null;
  options: ChatOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseError(response: Response): Promise<string> {
  let value: unknown = null;
  try {
    value = await response.json();
  } catch {
    value = null;
  }
  if (isRecord(value)) {
    const error = value.error;
    if (typeof error === 'string') return error;
    if (error !== undefined && error !== null) return String(error);
  }
  return `请求失败（${response.status}）`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const init: RequestInit = { ...options };
  if (options.body) init.headers = { 'content-type': 'application/json' };
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await responseError(response));
  const value: unknown = await response.json();
  return value as T;
}

function chatUsage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined;

  const costValue = isRecord(value.cost) ? value.cost : null;
  const cost: ChatUsageCost = {};
  if (costValue) {
    if (typeof costValue.input === 'number') cost.input = costValue.input;
    if (typeof costValue.output === 'number') cost.output = costValue.output;
    if (typeof costValue.cacheRead === 'number') cost.cacheRead = costValue.cacheRead;
    if (typeof costValue.cacheWrite === 'number') cost.cacheWrite = costValue.cacheWrite;
    if (typeof costValue.total === 'number') cost.total = costValue.total;
    if (typeof costValue.totalFromProvider === 'boolean') cost.totalFromProvider = costValue.totalFromProvider;
  }

  const usage: ChatUsage = {};
  if (typeof value.input === 'number') usage.input = value.input;
  if (typeof value.output === 'number') usage.output = value.output;
  if (typeof value.cacheRead === 'number') usage.cacheRead = value.cacheRead;
  if (typeof value.cacheWrite === 'number') usage.cacheWrite = value.cacheWrite;
  if (typeof value.cacheWrite1h === 'number') usage.cacheWrite1h = value.cacheWrite1h;
  if (typeof value.reasoning === 'number') usage.reasoning = value.reasoning;
  if (typeof value.totalTokens === 'number') usage.totalTokens = value.totalTokens;
  if (costValue) usage.cost = cost;
  return usage;
}

function streamEvent(value: unknown): ChatStreamEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;

  switch (value.type) {
    case 'text_delta':
    case 'thinking_delta':
      return typeof value.delta === 'string' ? { type: value.type, delta: value.delta } : null;
    case 'tool_call':
      return {
        type: 'tool_call',
        name: typeof value.name === 'string' ? value.name : '',
        arguments: value.arguments,
      };
    case 'done': {
      const result = isRecord(value.result) && typeof value.result.text === 'string'
        ? {
            text: value.result.text,
            ...(typeof value.result.thinking === 'string' ? { thinking: value.result.thinking } : {}),
          }
        : undefined;
      const usage = chatUsage(value.usage);
      return {
        type: 'done',
        ...(typeof value.stopReason === 'string' ? { stopReason: value.stopReason } : {}),
        ...(result ? { result } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case 'error':
      return typeof value.error === 'string' ? { type: 'error', error: value.error } : null;
    default:
      return null;
  }
}

export function getProviders(): Promise<ProviderState> {
  return request<ProviderState>('/api/providers');
}

export function discoverProviderModels(input: DiscoverProviderModelsInput): Promise<ProviderModelDiscovery> {
  return request<ProviderModelDiscovery>('/api/providers/models', { method: 'POST', body: JSON.stringify(input) });
}

export function detectModelInputs(input: ModelSelection): Promise<{ supported: boolean; inputs: ModelInput[] }> {
  return request('/api/providers/capabilities', { method: 'POST', body: JSON.stringify(input) });
}

export function saveProviderRequest(input: SaveProviderInput): Promise<ProviderState> {
  return request<ProviderState>('/api/providers', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteProviderRequest(id: string): Promise<ProviderState> {
  return request<ProviderState>(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function activateProviderRequest(input: ModelSelection): Promise<ProviderState> {
  return request<ProviderState>('/api/providers/active', { method: 'POST', body: JSON.stringify(input) });
}

export function reconcileRunsRequest(sessionId: string): Promise<ReconcileRunsResponse> {
  return request<ReconcileRunsResponse>('/api/runs/reconcile', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export function getSearchConfig(): Promise<SearchConfig> {
  return request<SearchConfig>('/api/search-config');
}

export function saveSearchConfigRequest(input: SaveSearchConfigInput): Promise<SearchConfig> {
  return request<SearchConfig>('/api/search-config', { method: 'POST', body: JSON.stringify(input) });
}

export async function streamChat(
  messages: readonly OutgoingChatMessage[],
  onEvent: (event: ChatStreamEvent) => void,
  model: ChatModelRef | null = null,
  options: ChatOptions = {},
): Promise<void> {
  const body: ChatRequestBody = {
    messages,
    providerId: model?.providerId,
    modelId: model?.modelId,
    options,
  };
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error('浏览器不支持流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (data) {
        const parsed: unknown = JSON.parse(data);
        const event = streamEvent(parsed);
        if (event) {
          if (event.type === 'error') throw new Error(event.error);
          onEvent(event);
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}
