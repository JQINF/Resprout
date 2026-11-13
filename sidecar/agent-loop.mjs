import { modelStream } from './model-stream.mjs';
import { resolveSearchAccess } from './provider-store.mjs';
import { runSearchTool, SEARCH_TOOLS } from './web-search.mjs';

const MAX_TOOL_ROUNDS = 6;

const SEARCH_SYSTEM_PROMPT = [
  '你已接入联网搜索能力，两个工具：',
  '- web_search：搜索互联网最新信息。回答近期事件、版本发布、新闻、实时数据，以及你不确定或可能过时的问题前，必须先调用它；摘要不足时用 fetch_page 读取原文。',
  '- fetch_page：抓取指定网页的正文。',
  '使用搜索语法提高精度：site:example.com 限定站点，after:2026-01-01 限定时间，lang:zh,en 限定语言。',
  '整理结果时注明来源（标题+URL），不要编造搜索不到的细节。若工具返回配置或余额错误，向用户说明并按提示处理。',
].join('\n');

function mergeUsage(accumulated, next) {
  if (!next) return accumulated;
  if (!accumulated) return { ...next };
  const merged = { ...accumulated };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (Number.isFinite(next[key])) merged[key] = (merged[key] ?? 0) + next[key];
  }
  const total = (accumulated.cost?.total ?? 0) + (next.cost?.total ?? 0);
  merged.cost = { total };
  return merged;
}

export function searchContext(enabled) {
  if (!enabled) return null;
  const access = resolveSearchAccess();
  if (!access) return null;
  return { access, tools: SEARCH_TOOLS };
}

export async function streamAnswer({ provider, modelId, context, signal, maxTokens, options = {}, onEvent = () => {} }) {
  const search = searchContext(options.webSearch === true);
  const messages = [...context.messages];
  let text = '';
  let thinking = '';
  let usage = null;
  let stopReason = 'stop';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundContext = search
      ? {
          ...context,
          messages,
          tools: search.tools,
          systemPrompt: [context.systemPrompt, SEARCH_SYSTEM_PROMPT].filter(Boolean).join('\n\n'),
        }
      : { ...context, messages };
    const stream = modelStream(provider, modelId, roundContext, signal, maxTokens, options);
    for await (const event of stream) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'tool_call') {
        await onEvent(event);
      }
    }
    const result = await stream.result();
    if (result.stopReason === 'error') throw new Error(result.errorMessage ?? '模型调用失败');
    const blocks = Array.isArray(result.content) ? result.content : [];
    text += blocks.filter(block => block?.type === 'text').map(block => block.text).join('');
    thinking += blocks.filter(block => block?.type === 'thinking').map(block => block.thinking).join('');
    usage = mergeUsage(usage, result.usage);
    stopReason = result.stopReason;
    messages.push(result);

    const calls = blocks.filter(block => block?.type === 'toolCall');
    if (!calls.length) break;
    for (const call of calls) {
      const name = String(call.name ?? '');
      await onEvent({ type: 'tool_call', name, arguments: call.arguments });
      let output;
      try {
        output = await runSearchTool(search.access, name, call.arguments, messages);
      } catch (error) {
        output = { isError: true, output: error.message };
      }
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: name,
        content: [{ type: 'text', text: output.output }],
        isError: output.isError === true,
        timestamp: Date.now(),
      });
    }
  }
  return { text, thinking, stopReason, usage };
}
