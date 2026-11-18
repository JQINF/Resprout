import { runInteractiveAgent } from './interactive-agent.ts';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Context,
  ImageContent,
  JsonValue,
  Message,
  ModelInputModality,
  TextContent,
  Usage,
} from '@earendil-works/pi-ai';
import {
  activateProvider,
  clearSearchAccess,
  deleteProvider,
  loadProviders,
  providerState,
  providerModelInputs,
  resolveProvider,
  resolveProviderAccess,
  saveProvider,
  saveSearchAccess,
  searchConfigState,
  type ActivateProviderInput,
  type ProviderAccessInput,
  type ProviderSelection,
  type SaveProviderInput,
  type SaveSearchAccessInput,
} from './provider-store.ts';
import { searchContext, streamAnswer, type ChatEvent, type ChatRequestOptions } from './agent-loop.ts';
import { deepseekSearch, searchGuidance } from './web-search.ts';
import { discoverModels } from './model-discovery.ts';
import { detectModelInputs } from './model-capabilities.ts';
import { deepseekModels } from './model-stream.ts';
import { closeDurable, durableChat, reconcileRuns } from './durable-run.ts';

type SearchAccessInput = Required<SaveSearchAccessInput>;

type MessageBlock = TextContent | ImageContent;

type ChatUserMessage = {
  role: 'user';
  content: string | MessageBlock[];
};

type ChatAssistantMessage = {
  role: 'assistant';
  content: string | TextContent[];
};

type ChatMessage = ChatUserMessage | ChatAssistantMessage;

type DurableTarget = {
  sessionId: string;
  requestId: string;
};

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

await loadProviders();
const port = Number(process.env.SIDECAR_PORT ?? 8787);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function writeEvent(response: ServerResponse, event: ChatEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  let text = '';
  for await (const chunk of request) {
    const buffer = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 12 * 1024 * 1024) throw new Error('请求内容过大');
    text += buffer.toString('utf8');
  }
  const value: unknown = JSON.parse(text);
  return value;
}

function isTextBlock(value: MessageBlock): value is TextContent {
  return value.type === 'text';
}

function parseChatMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;
  const role = value.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof value.content === 'string') return { role, content: value.content };
  if (!Array.isArray(value.content) || !value.content.length || value.content.length > 6) return null;
  const blocks: MessageBlock[] = [];
  let images = 0;
  let totalBytes = 0;
  for (const blockValue of value.content) {
    if (!isRecord(blockValue)) return null;
    if (blockValue.type === 'text') {
      if (typeof blockValue.text !== 'string') return null;
      blocks.push({ type: 'text', text: blockValue.text });
    } else if (blockValue.type === 'image') {
      if (role !== 'user' || typeof blockValue.mimeType !== 'string' || !IMAGE_MIME_TYPES.has(blockValue.mimeType)) return null;
      if (typeof blockValue.data !== 'string') return null;
      if (!blockValue.data.length || blockValue.data.length > 2_900_000) return null;
      images += 1;
      totalBytes += blockValue.data.length;
      blocks.push({ type: 'image', data: blockValue.data, mimeType: blockValue.mimeType });
    } else {
      return null;
    }
  }
  if (images > 4 || totalBytes > 8_500_000) return null;
  return role === 'user' ? { role, content: blocks } : { role, content: blocks.filter(isTextBlock) };
}

function parseChatMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    const message = parseChatMessage(item);
    if (!message) return null;
    messages.push(message);
  }
  return messages;
}

function messageHasImage(message: ChatMessage): boolean {
  return Array.isArray(message.content) && message.content.some(block => block.type === 'image');
}

function readProviderSelection(value: unknown): ProviderSelection {
  const record = isRecord(value) ? value : {};
  const selection: ProviderSelection = {};
  for (const key of ['providerId', 'modelId'] as const) {
    const field = record[key];
    if (!field) continue;
    if (typeof field !== 'string') throw new Error('供应商或模型无效');
    selection[key] = field;
  }
  return selection;
}

function readProviderAccessInput(value: unknown): ProviderAccessInput {
  const record = isRecord(value) ? value : {};
  const input: ProviderAccessInput = {
    kind: record.kind === 'deepseek' ? 'deepseek' : 'openai',
  };
  if (typeof record.providerId === 'string') input.providerId = record.providerId;
  if (typeof record.baseUrl === 'string') input.baseUrl = record.baseUrl;
  if (typeof record.apiKey === 'string') input.apiKey = record.apiKey;
  return input;
}

function readProviderSaveInput(value: unknown): SaveProviderInput {
  const record = isRecord(value) ? value : {};
  const input: SaveProviderInput = {
    name: String(record.name ?? ''),
    kind: record.kind === 'deepseek' ? 'deepseek' : 'openai',
    baseUrl: String(record.baseUrl ?? ''),
    apiKey: String(record.apiKey ?? ''),
    activate: record.activate !== false,
  };
  if (typeof record.id === 'string') input.id = record.id;
  if (Array.isArray(record.modelIds)) input.modelIds = record.modelIds.map(id => String(id));
  if (record.modelContexts !== undefined) {
    const modelContexts: Record<string, number> = {};
    if (isRecord(record.modelContexts)) {
      for (const [key, raw] of Object.entries(record.modelContexts)) {
        const number = Number(raw);
        if (Number.isFinite(number)) modelContexts[key] = number;
      }
    }
    input.modelContexts = modelContexts;
  }
  if (record.modelInputs !== undefined) {
    const modelInputs: Record<string, ModelInputModality[]> = {};
    if (isRecord(record.modelInputs)) {
      for (const [key, raw] of Object.entries(record.modelInputs)) {
        if (!Array.isArray(raw)) continue;
        const values = [...new Set(raw.filter((item): item is ModelInputModality => item === 'text' || item === 'image'))];
        if (values.length) modelInputs[key] = values;
      }
    }
    input.modelInputs = modelInputs;
  }
  return input;
}

function readProviderActivateInput(value: unknown): Required<ActivateProviderInput> {
  const record = isRecord(value) ? value : {};
  return {
    providerId: String(record.providerId ?? ''),
    modelId: String(record.modelId ?? ''),
  };
}

function readSearchAccessInput(value: unknown): SearchAccessInput {
  const record = isRecord(value) ? value : {};
  return {
    apiKey: String(record.apiKey ?? ''),
    baseUrl: String(record.baseUrl ?? ''),
  };
}

function readChatOptions(value: unknown): ChatRequestOptions {
  if (!isRecord(value)) return {};
  const options: ChatRequestOptions = {
    quickAction: value.quickAction === true,
    webSearch: value.webSearch === true,
    structuredOutput: Boolean(value.structuredOutput),
    durable: Boolean(value.durable),
  };
  if (typeof value.purpose === 'string') options.purpose = value.purpose;
  if (typeof value.sessionId === 'string') options.sessionId = value.sessionId;
  if (typeof value.requestId === 'string') options.requestId = value.requestId;
  if (typeof value.parentRequestId === 'string') options.parentRequestId = value.parentRequestId;
  if (typeof value.conversationContent === 'string') options.conversationContent = value.conversationContent;
  if (typeof value.schemaName === 'string') options.schemaName = value.schemaName;
  if (typeof value.temperature === 'number') options.temperature = value.temperature;
  if (isJsonValue(value.schema)) options.schema = value.schema;
  return options;
}

function durableSelection(options: ChatRequestOptions): DurableTarget | null {
  if (options.durable !== true || !options.sessionId || !options.requestId) return null;
  return { sessionId: options.sessionId, requestId: options.requestId };
}

function contextMessage(message: ChatMessage, providerId: string, modelId: string): Message {
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: Date.now() };
  }
  const content: TextContent[] = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: providerId,
    model: modelId,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = await readJson(request);
  if (!isRecord(input)) {
    writeJson(response, 400, { error: 'messages 格式无效' });
    return;
  }
  const messages = parseChatMessages(input.messages);
  if (!messages) {
    writeJson(response, 400, { error: 'messages 格式无效' });
    return;
  }
  const selected = resolveProvider(readProviderSelection(input));
  if (!selected) {
    writeJson(response, 503, { error: '请先在“模型设置”中添加供应商' });
    return;
  }
  const modelId = selected.modelId;
  if (!modelId) {
    writeJson(response, 503, { error: '供应商或模型无效' });
    return;
  }
  const hasImages = messages.some(messageHasImage);
  const modelInputs = providerModelInputs(selected.provider, modelId);
  if (hasImages && !modelInputs.includes('image')) {
    writeJson(response, 400, { error: '当前模型未确认支持图片，图片内容未发送' });
    return;
  }

  const context: Context = {
    messages: messages.map(message => contextMessage(message, selected.provider.id, modelId)),
  };
  const controller = new AbortController();
  const options = readChatOptions(input.options);
  const webSearch = options.webSearch === true;
  if (webSearch && !searchContext(true)) {
    writeJson(response, 400, { error: searchGuidance() });
    return;
  }
  const durable = durableSelection(options);
  if (durable && messages.some(messageHasImage)) {
    writeJson(response, 400, { error: '图片请求不进入 durable 存储，请使用普通多模态管线' });
    return;
  }
  response.on('close', () => {
    if (!durable && !response.writableEnded) controller.abort();
  });
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();

  const interactive = options.purpose === 'interactive' || options.purpose === 'interactive-review';
  if (durable) {
    const result = await durableChat({
      provider: selected.provider,
      modelId,
      sessionId: durable.sessionId,
      requestId: durable.requestId,
      messages: context.messages,
      quickAction: options.quickAction === true,
      webSearch,
      parentRequestId: options.parentRequestId,
      conversationContent: options.conversationContent,
      onEvent: event => writeEvent(response, event),
    });
    writeEvent(response, {
      type: 'done',
      stopReason: result.stopReason,
      result: { text: result.text, thinking: result.thinking },
      usage: result.usage,
    });
    response.end();
    return;
  }
  if (options.purpose === 'interactive') {
    try {
      const text = await runInteractiveAgent({
        provider: selected.provider, modelId, signal: controller.signal,
        vision: modelInputs.includes('image'),
        prompt: messages.map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : (message.content as MessageBlock[]).filter((block): block is TextContent => block.type === 'text').map(block => block.text).join('\n')}`).join('\n\n'),
        images: messages.flatMap(message => typeof message.content === 'string' ? [] : (message.content as MessageBlock[]).filter((block): block is ImageContent => block.type === 'image')),
        onEvent: event => writeEvent(response, event),
      });
      writeEvent(response, { type: 'text_delta', delta: text });
      writeEvent(response, { type: 'done', stopReason: 'stop', usage: null });
    } catch (error) {
      const agentTrace = isRecord(error) ? error.agentTrace : undefined;
      writeEvent(response, { type: 'error', error: errorMessage(error), ...(agentTrace !== undefined ? { agentTrace } : {}) });
    }
    response.end();
    return;
  }
  const maxTokens = options.purpose === 'route' ? 512 : interactive ? 32768 : 4096;
  try {
    const result = await streamAnswer({
      provider: selected.provider,
      modelId,
      context,
      signal: controller.signal,
      maxTokens,
      options,
      onEvent: event => writeEvent(response, event),
    });
    writeEvent(response, {
      type: 'done',
      stopReason: result.stopReason,
      result: { text: result.text, thinking: result.thinking },
      usage: result.usage,
    });
  } catch (error) {
    writeEvent(response, { type: 'error', error: errorMessage(error) });
  }
  response.end();
}

async function handleModelDiscovery(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = await readJson(request);
  const access = resolveProviderAccess(readProviderAccessInput(input));
  const discovered = await discoverModels(access);
  let models: readonly string[] = discovered.models;
  let filteredCount = discovered.filteredCount;
  if (access.kind === 'deepseek') {
    const supported = new Map<string, string>(
      deepseekModels.getModels('deepseek').map(model => [model.id, model.id] as const),
    );
    supported.set('deepseek-v4-flash', 'deepseek-flash');
    const compatible = models.map(id => supported.get(id)).filter((id): id is string => id !== undefined);
    filteredCount += models.length - compatible.length;
    models = [...new Set(compatible)];
  }
  writeJson(response, 200, {
    models,
    contexts: discovered.contexts,
    inputs: discovered.inputs,
    notice: filteredCount ? `已过滤 ${filteredCount} 个非对话或当前尚未适配的模型` : '',
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/search-config') {
      writeJson(response, 200, searchConfigState());
    } else if (request.method === 'POST' && url.pathname === '/api/search-config') {
      const input = await readJson(request);
      if (isRecord(input) && input.clear === true) {
        writeJson(response, 200, await clearSearchAccess());
      } else {
        const { apiKey: rawApiKey, baseUrl: rawBaseUrl } = readSearchAccessInput(input);
        const apiKey = rawApiKey.trim();
        if (!apiKey) throw new Error('API Key 不能为空');
        const baseUrl = rawBaseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
        await deepseekSearch({ apiKey, baseUrl }, { query: 'DeepSeek', count: 1 }, []);
        writeJson(response, 200, await saveSearchAccess({ apiKey, baseUrl }));
      }
    } else if (request.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(request, response);
    } else if (request.method === 'POST' && url.pathname === '/api/runs/reconcile') {
      const input = await readJson(request);
      const sessionId = isRecord(input) ? String(input.sessionId ?? '') : '';
      writeJson(response, 200, { runs: await reconcileRuns(sessionId) });
    } else if (request.method === 'GET' && url.pathname === '/api/providers') {
      writeJson(response, 200, providerState());
    } else if (request.method === 'POST' && url.pathname === '/api/providers/capabilities') {
      const input = await readJson(request);
      const selected = resolveProvider(readProviderSelection(input));
      if (!selected) {
        writeJson(response, 503, { error: '请先在“模型设置”中添加供应商' });
        return;
      }
      const inputs = await detectModelInputs(selected.provider, selected.modelId);
      writeJson(response, 200, { supported: inputs.includes('image'), inputs });
    } else if (request.method === 'POST' && url.pathname === '/api/providers/models') {
      await handleModelDiscovery(request, response);
    } else if (request.method === 'POST' && url.pathname === '/api/providers') {
      writeJson(response, 200, await saveProvider(readProviderSaveInput(await readJson(request))));
    } else if (request.method === 'POST' && url.pathname === '/api/providers/active') {
      writeJson(response, 200, await activateProvider(readProviderActivateInput(await readJson(request))));
    } else if (request.method === 'DELETE' && url.pathname.startsWith('/api/providers/')) {
      writeJson(response, 200, await deleteProvider(decodeURIComponent(url.pathname.slice('/api/providers/'.length))));
    } else {
      writeJson(response, 404, { error: 'Not found' });
    }
  } catch (error) {
    if (response.headersSent) {
      writeEvent(response, { type: 'error', error: errorMessage(error) });
      response.end();
    } else {
      writeJson(response, 400, { error: errorMessage(error) });
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Resprout sidecar listening on http://127.0.0.1:${port}`);
});
async function shutdown(): Promise<void> {
  await closeDurable();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
