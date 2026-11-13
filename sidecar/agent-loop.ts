import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  JsonObject,
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
import { runSearchTool, SEARCH_TOOLS, type SearchToolResult } from './web-search.ts';

const MAX_TOOL_ROUNDS = 6;

export const SEARCH_SYSTEM_PROMPT = [
  '你已接入联网搜索能力，两个工具：',
  '- web_search：搜索互联网最新信息。回答近期事件、版本发布、新闻、实时数据，以及你不确定或可能过时的问题前，必须先调用它；摘要不足时用 fetch_page 读取原文。',
  '- fetch_page：抓取指定网页的正文。',
  '使用搜索语法提高精度：site:example.com 限定站点，after:2026-01-01 限定时间，lang:zh,en 限定语言。',
  '整理结果时注明来源（标题+URL），不要编造搜索不到的细节。若工具返回配置或余额错误，向用户说明并按提示处理。',
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
  contentIndex?: number;
  partial?: AssistantMessage;
};

export interface ToolCallEvent {
  type: 'tool_call';
  name: string;
  arguments: JsonObject;
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
  const messages: Message[] = [...context.messages];
  let text = '';
  let thinking = '';
  let usage: AnswerUsage | null = null;
  let stopReason: StopReason = 'stop';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundContext: Context = search
      ? {
          ...context,
          messages,
          tools: search.tools,
          systemPrompt: [context.systemPrompt, SEARCH_SYSTEM_PROMPT]
            .filter((part): part is string => Boolean(part))
            .join('\n\n'),
        }
      : { ...context, messages };
    const stream: AssistantMessageEventStream = modelStream(provider, modelId, roundContext, signal, maxTokens, options);
    for await (const event of stream) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        await onEvent(event);
      }
    }
    const result: AssistantMessage = await stream.result();
    if (result.stopReason === 'error') throw new Error(result.errorMessage ?? '模型调用失败');
    const blocks = Array.isArray(result.content) ? result.content : [];
    text += blocks
      .filter((block): block is TextContent => block.type === 'text')
      .map(block => block.text)
      .join('');
    thinking += blocks
      .filter((block): block is ThinkingContent => block.type === 'thinking')
      .map(block => block.thinking)
      .join('');
    usage = mergeUsage(usage, result.usage);
    stopReason = result.stopReason;
    messages.push(result);

    const calls = blocks.filter((block): block is ToolCall => block.type === 'toolCall');
    if (!calls.length) break;
    if (!search) break;
    for (const call of calls) {
      const name = call.name;
      await onEvent({ type: 'tool_call', name, arguments: call.arguments });
      let output: SearchToolResult;
      try {
        output = await runSearchTool(search.access, name, call.arguments, messages);
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
  return { text, thinking, stopReason, usage };
}
