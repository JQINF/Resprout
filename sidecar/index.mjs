import http from 'node:http';
import {
  activateProvider,
  clearSearchAccess,
  deleteProvider,
  loadProviders,
  providerState,
  resolveProvider,
  resolveProviderAccess,
  saveProvider,
  saveSearchAccess,
  searchConfigState,
} from './provider-store.mjs';
import { searchContext, streamAnswer } from './agent-loop.mjs';
import { deepseekSearch, searchGuidance } from './web-search.mjs';
import { discoverModels } from './model-discovery.mjs';
import { deepseekModels } from './model-stream.mjs';
import { closeDurable, durableChat, reconcileRuns } from './durable-run.mjs';

await loadProviders();
const port = Number(process.env.SIDECAR_PORT ?? 8787);

function writeJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function writeEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request) {
  let size = 0;
  let text = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error('请求内容过大');
    text += chunk;
  }
  return JSON.parse(text);
}

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function contentText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
}

function validMessage(message) {
  if (!['user', 'assistant'].includes(message.role)) return false;
  if (typeof message.content === 'string') return true;
  if (!Array.isArray(message.content) || !message.content.length || message.content.length > 6) return false;
  let images = 0;
  let totalBytes = 0;
  for (const block of message.content) {
    if (block?.type === 'text') {
      if (typeof block.text !== 'string') return false;
    } else if (block?.type === 'image') {
      if (message.role !== 'user' || !IMAGE_MIME_TYPES.has(block.mimeType) || typeof block.data !== 'string') return false;
      if (!block.data.length || block.data.length > 2_900_000) return false;
      images += 1;
      totalBytes += block.data.length;
    } else return false;
  }
  return images <= 4 && totalBytes <= 8_500_000;
}

async function handleChat(request, response) {
  const input = await readJson(request);
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.some(message => !validMessage(message))) {
    writeJson(response, 400, { error: 'messages 格式无效' });
    return;
  }
  const selected = resolveProvider(input);
  if (!selected) {
    writeJson(response, 503, { error: '请先在“模型设置”中添加供应商' });
    return;
  }
  const hasImages = input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));
  const modelInputs = selected.provider.kind === 'deepseek'
    ? deepseekModels.getModel('deepseek', selected.modelId)?.input ?? ['text']
    : selected.provider.modelInputs?.[selected.modelId] ?? ['text'];
  if (hasImages && !modelInputs.includes('image')) {
    writeJson(response, 400, { error: '当前模型未确认支持图片，图片内容未发送' });
    return;
  }

  const context = {
    messages: input.messages.map(message => ({
      role: message.role,
      timestamp: Date.now(),
      content: message.role === 'assistant'
        ? typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
        : message.content,
    })),
  };
  const controller = new AbortController();
  const options = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
  const webSearch = options.webSearch === true;
  if (webSearch && !searchContext(true)) {
    writeJson(response, 400, { error: searchGuidance() });
    return;
  }
  const durable = Boolean(options.durable && options.sessionId && options.requestId);
  if (durable && input.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'))) {
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

  const interactive = ['interactive', 'interactive-review'].includes(options.purpose);
  if (durable) {
    const result = await durableChat({
      provider: selected.provider,
      modelId: selected.modelId,
      sessionId: options.sessionId,
      requestId: options.requestId,
      messages: context.messages,
      quickAction: options.quickAction === true,
      webSearch,
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
  const maxTokens = options.purpose === 'route' ? 512 : interactive ? 32768 : 4096;
  try {
    const result = await streamAnswer({
      provider: selected.provider,
      modelId: selected.modelId,
      context,
      signal: controller.signal,
      maxTokens,
      options,
      onEvent: event => writeEvent(response, event),
    });
    writeEvent(response, { type: 'done', stopReason: result.stopReason, usage: result.usage });
  } catch (error) {
    writeEvent(response, { type: 'error', error: error.message });
  }
  response.end();
}

async function handleModelDiscovery(request, response) {
  const access = resolveProviderAccess(await readJson(request));
  const discovered = await discoverModels(access);
  let models = discovered.models;
  let filteredCount = discovered.filteredCount;
  if (access.kind === 'deepseek') {
    const supported = new Map(deepseekModels.getModels('deepseek').map(model => [model.id, model.id]));
    supported.set('deepseek-v4-flash', 'deepseek-flash');
    const compatible = models.map(id => supported.get(id)).filter(Boolean);
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

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/search-config') {
      writeJson(response, 200, searchConfigState());
    } else if (request.method === 'POST' && url.pathname === '/api/search-config') {
      const input = await readJson(request);
      if (input.clear === true) {
        writeJson(response, 200, await clearSearchAccess());
      } else {
        const apiKey = String(input.apiKey ?? '').trim();
        if (!apiKey) throw new Error('API Key 不能为空');
        const baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.deepseek.com';
        await deepseekSearch({ apiKey, baseUrl }, { query: 'DeepSeek', count: 1 }, []);
        writeJson(response, 200, await saveSearchAccess({ apiKey, baseUrl }));
      }
    } else if (request.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(request, response);
    } else if (request.method === 'POST' && url.pathname === '/api/runs/reconcile') {
      const input = await readJson(request);
      writeJson(response, 200, { runs: await reconcileRuns(String(input.sessionId ?? '')) });
    } else if (request.method === 'GET' && url.pathname === '/api/providers') {
      writeJson(response, 200, providerState());
    } else if (request.method === 'POST' && url.pathname === '/api/providers/models') {
      await handleModelDiscovery(request, response);
    } else if (request.method === 'POST' && url.pathname === '/api/providers') {
      writeJson(response, 200, await saveProvider(await readJson(request)));
    } else if (request.method === 'POST' && url.pathname === '/api/providers/active') {
      writeJson(response, 200, await activateProvider(await readJson(request)));
    } else if (request.method === 'DELETE' && url.pathname.startsWith('/api/providers/')) {
      writeJson(response, 200, await deleteProvider(decodeURIComponent(url.pathname.slice('/api/providers/'.length))));
    } else {
      writeJson(response, 404, { error: 'Not found' });
    }
  } catch (error) {
    if (response.headersSent) {
      writeEvent(response, { type: 'error', error: error.message });
      response.end();
    } else {
      writeJson(response, 400, { error: error.message });
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Resprout sidecar listening on http://127.0.0.1:${port}`);
});
async function shutdown() {
  await closeDurable();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
