import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  JsonValue,
  Message,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import { modelStream } from './model-stream.ts';
import { resolveSearchAccess, type SearchAccess } from './provider-store.ts';
import { runSearchTool, SEARCH_TOOLS, WEB_SEARCH_TOOLS, type SearchToolResult } from './web-search.ts';
import { FETCH_TOOLS, messagesNeedFetch, runFetchTool } from './web-fetch.ts';
import { ANSWER_SYSTEM_PROMPT } from './answer-discipline.ts';

export const SEARCH_SYSTEM_PROMPT = [
  '你已接入联网搜索能力，两个工具：',
  '- web_search：搜索互联网最新信息。回答近期事件、版本发布、新闻、实时数据，以及你不确定或可能过时的问题前，必须先调用它；摘要不足时用 fetch_page 读取原文。',
  '- fetch_page：抓取指定网页的正文。',
  '使用搜索语法提高精度：site:example.com 限定站点，after:2026-01-01 限定时间，lang:zh,en 限定语言。',
  '工具调用要克制：优先一次读取信息量最大的页面，不要逐个文件遍历；拿到足够材料后尽快整理回答。',
  '整理结果时注明来源（标题+URL），不要编造搜索不到的细节。若工具返回配置或余额错误，向用户说明并按提示处理。',
].join('\n');

export const FETCH_SYSTEM_PROMPT = [
  '你可以使用 fetch_page 工具抓取 http/https 网页的正文（已自动提取主要内容）。',
  '当用户的问题包含链接，或明确要求查看、查阅、研究某个项目或资料时，必须先调用 fetch_page 读取相关内容再回答，并注明来源 URL；没有链接时可读取官方项目页、论文页或对应的搜索页面。',
  '抓取要克制：优先一次读取信息量最大的页面（如 README、核心方法文件），不要逐个文件遍历；拿到足够材料后尽快整理回答。',
  '若抓取失败（链接无效、页面禁止访问、不是网页文件等），如实向用户说明原因并给出可执行的建议。',
].join('\n');

type ModelStreamProvider = Parameters<typeof modelStream>[0];

export interface AnswerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
    totalFromProvider?: boolean;
  };
}

export interface StreamAnswerOptions {
  quickAction?: boolean;
  webSearch?: boolean;
  structuredOutput?: boolean;
  schema?: JsonValue;
  schemaName?: string;
  temperature?: number;
}

export interface ChatRequestOptions extends StreamAnswerOptions {
  purpose?: string;
  sessionId?: string;
  requestId?: string;
  durable?: boolean;
  parentRequestId?: string;
  conversationContent?: string;
}

export interface StreamAnswerResult {
  text: string;
  thinking: string;
  stopReason: StopReason;
  usage: AnswerUsage | null;
}

export interface SearchContext {
  access: SearchAccess;
  tools: Tool[];
}

export type ChatDeltaEvent = {
  type: 'text_delta' | 'thinking_delta';
  delta: string;
  replace?: boolean;
  contentIndex?: number;
  partial?: AssistantMessage;
};

export interface ToolCallEvent {
  type: 'tool_call';
  name: string;
  arguments: unknown;
  agentTrace?: unknown;
}

export interface DoneEvent {
  type: 'done';
  stopReason: StopReason;
  usage: AnswerUsage | null;
  result?: {
    text: string;
    thinking: string;
  };
}

export interface ErrorEvent {
  type: 'error';
  error: string;
  agentTrace?: unknown;
}

export type ChatEvent = ChatDeltaEvent | ToolCallEvent | DoneEvent | ErrorEvent;

export type ChatEventSink = (event: ChatEvent) => void | Promise<void>;

export type ChatEventListener = (event: ChatEvent) => void;

export interface StreamAnswerInput {
  provider: ModelStreamProvider;
  modelId: string;
  context: Context;
  signal: AbortSignal;
  maxTokens: number;
  options?: StreamAnswerOptions;
  onEvent?: ChatEventSink;
}

function mergeUsage(accumulated: AnswerUsage | null, next: Usage | null): AnswerUsage | null {
  if (!next) return accumulated;
  if (!accumulated) return { ...next };
  const merged: AnswerUsage = { ...accumulated };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (Number.isFinite(next[key])) merged[key] = (merged[key] ?? 0) + next[key];
  }
  const total = (accumulated.cost?.total ?? 0) + (next.cost?.total ?? 0);
  merged.cost = { total };
  return merged;
}

export function searchContext(enabled: boolean): SearchContext | null {
  if (!enabled) return null;
  const access = resolveSearchAccess();
  if (!access) return null;
  return { access, tools: SEARCH_TOOLS };
}

export async function streamAnswer({
  provider,
  modelId,
  context,
  signal,
  maxTokens,
  options = {},
  onEvent = () => {},
}: StreamAnswerInput): Promise<StreamAnswerResult> {
  const search = searchContext(options.webSearch === true);
  // 联网搜索、链接或明确查阅意图都可使用本地 fetch_page，不依赖 DeepSeek。
  const wantFetch = Boolean(search) || messagesNeedFetch(context.messages);
  const tools = [...(search ? WEB_SEARCH_TOOLS : []), ...(wantFetch ? FETCH_TOOLS : [])];
  const toolPrompt = search
    ? SEARCH_SYSTEM_PROMPT
    : wantFetch ? FETCH_SYSTEM_PROMPT : '';
  const messages: Message[] = [...context.messages];
  let text = '';
  let thinking = '';
  let usage: AnswerUsage | null = null;
  let stopReason: StopReason = 'stop';

  // 工具轮次不设上限：读多少材料由模型自行判断，直到它不再调用工具为止。
  for (;;) {
    const systemPrompt = [context.systemPrompt, ANSWER_SYSTEM_PROMPT, toolPrompt]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    const roundContext: Context = { ...context, messages, ...(tools.length ? { tools } : {}), systemPrompt };
    const stream: AssistantMessageEventStream = modelStream(provider, modelId, roundContext, signal, maxTokens, options);
    let emittedText = false;
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        await onEvent({ ...event, ...(!emittedText ? { replace: true } : {}) });
        emittedText = true;
      } else if (event.type === 'thinking_delta') {
        await onEvent(event);
      }
    }
    const result: AssistantMessage = await stream.result();
    if (result.stopReason === 'error') throw new Error(result.errorMessage ?? '模型调用失败');
    const blocks = Array.isArray(result.content) ? result.content : [];
    const roundText = blocks
      .filter((block): block is TextContent => block.type === 'text')
      .map(block => block.text)
      .join('');
    text = roundText;
    thinking += blocks
      .filter((block): block is ThinkingContent => block.type === 'thinking')
      .map(block => block.thinking)
      .join('');
    usage = mergeUsage(usage, result.usage);
    stopReason = result.stopReason;
    messages.push(result);

    const calls = blocks.filter((block): block is ToolCall => block.type === 'toolCall');
    if (!calls.length) break;
    if (!tools.length) break;
    for (const call of calls) {
      const name = call.name;
      await onEvent({ type: 'tool_call', name, arguments: call.arguments });
      let output: SearchToolResult;
      try {
        if (name === 'fetch_page') {
          output = await runFetchTool(name, call.arguments);
        } else if (search) {
          output = await runSearchTool(search.access, name, call.arguments, messages);
        } else {
          output = { isError: true, output: `工具 ${name} 当前不可用` };
        }
      } catch (error) {
        output = { isError: true, output: error instanceof Error ? error.message : String(error) };
      }
      const toolResult: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: name,
        content: [{ type: 'text', text: output.output }],
        isError: output.isError === true,
        timestamp: Date.now(),
      };
      messages.push(toolResult);
    }
  }
  // stopReason "length" = 输出被 token 预算截断：这条消息不完整，不能当最终回答（否则会把计划/思考过程当回答）。
  if (stopReason === 'length') {
    throw new Error('模型输出达到长度上限被截断，未能完成回答。请重试，或把问题拆得更具体一些。');
  }
  return { text, thinking, stopReason, usage };
}
