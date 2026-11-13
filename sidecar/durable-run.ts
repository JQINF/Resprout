import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonRepresentation, JsonValue } from '@earendil-works/chord/json';
import {
  createRegistry,
  defineDocFamily,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  LiveDoc,
} from '@earendil-works/pi-durable';
import type {
  AgentChange,
  CompactionSettings,
  Conversation,
  ConversationId,
  ConversationWatch,
  EntryId,
  Harness as HarnessInstance,
  Id,
  JsonObject,
  LiveState,
  SubmissionId,
  TaskId,
  TaskOutcome,
  TaskRecord,
  UserInput,
} from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { resolve } from 'node:path';
import type { AssistantMessage, Message, StopReason } from '@earendil-works/pi-ai';
import { createProviderModels, deepseekModels, QUICK_ACTION_SYSTEM_PROMPT } from './model-stream.ts';
import { SEARCH_SYSTEM_PROMPT, streamAnswer } from './agent-loop.ts';
import type { AnswerUsage, ChatEvent, ChatEventListener } from './agent-loop.ts';
import { providerState, resolveProvider, resolveSearchAccess } from './provider-store.ts';
import type { ProviderConfig } from './provider-store.ts';
import { runSearchTool, SEARCH_TOOLS } from './web-search.ts';

const durableRoot = resolve(process.env.RESPROUT_CONFIG_DIR ?? '.resprout', 'durable');
const MAX_TOOL_ROUNDS = 6;

interface RunIndex extends JsonObject {
  taskId: TaskId<AnswerResult> | null;
  sessionId: string;
  requestId: string;
  conversationId: ConversationId | null;
  submissionId: SubmissionId | null;
  answerEntryId: EntryId | null;
}

interface AnswerTaskInput {
  providerId: string;
  modelId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];
  quickAction: boolean;
  webSearch: boolean;
}

interface AnswerState {
  phase: 'run';
  text: string;
  thinking: string;
}

interface AnswerResult {
  text: string;
  thinking: string;
  stopReason: StopReason;
  usage: AnswerUsage | null;
}

interface HarnessBundle {
  harness: HarnessInstance;
  storage: JsonlStorage;
}

interface ListenerState {
  listeners: Set<ChatEventListener>;
  watch: ConversationWatch | null;
  text: string;
  thinking: string;
  toolCalls: Set<string>;
}

export interface DurableChatInput {
  provider: ProviderConfig;
  modelId: string;
  sessionId: string;
  requestId: string;
  messages: Message[];
  quickAction?: boolean;
  webSearch?: boolean;
  parentRequestId?: string;
  conversationContent?: string;
  onEvent: ChatEventListener;
}

interface RunResult {
  requestId: string;
  status: 'running' | 'done' | 'failed';
  text: string;
  thinking: string;
  stopReason: StopReason | null;
  usage: AnswerUsage | null;
  error: string;
}

interface MessageParts {
  text: string;
  thinking: string;
}

const harnesses = new Map<string, Promise<HarnessBundle>>();
const listeners = new Map<string, ListenerState>();
const answerRuns = new Map<string, Promise<AnswerResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emit(requestId: string, event: ChatEvent): void {
  const state = listeners.get(requestId);
  if (!state) return;
  for (const listener of state.listeners) {
    try { listener(event); } catch {}
  }
}

function addListener(requestId: string, listener: ChatEventListener): ListenerState {
  let state = listeners.get(requestId);
  if (!state) {
    state = { listeners: new Set(), watch: null, text: '', thinking: '', toolCalls: new Set() };
    listeners.set(requestId, state);
  }
  state.listeners.add(listener);
  return state;
}

async function removeListener(requestId: string, listener: ChatEventListener): Promise<void> {
  const state = listeners.get(requestId);
  if (!state) return;
  state.listeners.delete(listener);
  if (state.listeners.size) return;
  if (state.watch) await state.watch.stop().catch(() => {});
  listeners.delete(requestId);
}

function messageParts(message: AssistantMessage | JsonRepresentation<AssistantMessage> | undefined): MessageParts {
  const parts: MessageParts = { text: '', thinking: '' };
  for (const block of message?.content ?? []) {
    if (block.type === 'text') parts.text += block.text;
    if (block.type === 'thinking') parts.thinking += block.thinking;
  }
  return parts;
}

function emitWatchValue(requestId: string, state: ListenerState, live: LiveState | undefined): void {
  const parts = messageParts(live?.generation?.message);
  if (parts.text.startsWith(state.text)) {
    const delta = parts.text.slice(state.text.length);
    if (delta) emit(requestId, { type: 'text_delta', delta });
  }
  if (parts.thinking.startsWith(state.thinking)) {
    const delta = parts.thinking.slice(state.thinking.length);
    if (delta) emit(requestId, { type: 'thinking_delta', delta });
  }
  state.text = parts.text;
  state.thinking = parts.thinking;
  for (const tool of live?.tools ?? []) {
    if (state.toolCalls.has(tool.callId)) continue;
    state.toolCalls.add(tool.callId);
    emit(requestId, { type: 'tool_call', name: tool.name, arguments: {} });
  }
}

async function attachWatch(requestId: string, conversation: Conversation): Promise<void> {
  const state = listeners.get(requestId);
  if (!state || state.watch) return;
  const watch = await conversation.watch(BACKGROUND_CONTEXT);
  state.watch = watch;
  emitWatchValue(requestId, state, watch.value.docs['pi.live'] as LiveState | undefined);
  watch.start(async call => {
    if (call.kind === 'value') {
      emitWatchValue(requestId, state, call.value.docs['pi.live'] as LiveState | undefined);
    }
  });
}

const SearchExtension = defineExtension({
  name: 'resprout.search',
  tools: SEARCH_TOOLS.map(tool => defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async args => {
      const access = resolveSearchAccess();
      if (!access) {
        return { output: [{ type: 'text' as const, text: '联网搜索尚未配置 API Key' }], isError: true };
      }
      const result = await runSearchTool(access, tool.name, args as JsonObject, []);
      return {
        output: [{ type: 'text' as const, text: result.output }],
        isError: result.isError,
      };
    },
  })),
});

const RunIndexDoc = defineDocFamily({
  kind: 'resprout.run',
  scope: 'session',
  family: true,
  version: 1,
  initial: (): RunIndex => ({
    taskId: null,
    sessionId: '',
    requestId: '',
    conversationId: null,
    submissionId: null,
    answerEntryId: null,
  }),
  checkpointWhen: () => false,
});

const AnswerTask = defineTask<AnswerTaskInput, AnswerState, AnswerResult, object>({
  name: 'resprout.answer',
  version: 1,
  initial: (): AnswerState => ({ phase: 'run', text: '', thinking: '' }),
  phases: {
    run: async (task, runtime, context) => {
      const { providerId, modelId, requestId, messages, quickAction, webSearch } = task.input;
      let text = '';
      let thinking = '';
      try {
        const selection = resolveProvider({ providerId, modelId });
        if (!selection) throw new Error('供应商或模型无效');
        const result = await streamAnswer({
          provider: selection.provider,
          modelId,
          context: { messages },
          signal: runtime.signal,
          maxTokens: 4096,
          options: { quickAction, webSearch },
          onEvent: async event => {
            if (event.type === 'text_delta') text += event.delta;
            if (event.type === 'thinking_delta') thinking += event.delta;
            emit(requestId, event);
            await runtime.commit(() => ({
              status: 'running',
              checkpoint: { phase: 'run', text, thinking },
            }), context, { persistence: { kind: 'deferred', withinMs: 250 } });
          },
        });
        await runtime.commit(() => ({
          status: 'terminal',
          outcome: {
            status: 'completed',
            result: { text: result.text, thinking: result.thinking, stopReason: result.stopReason, usage: result.usage },
          },
        }), context);
      } catch (error) {
        await runtime.commit(() => ({
          status: 'terminal',
          outcome: { status: 'failed', error: { message: errorMessage(error) } },
        }), context);
      }
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});

function primaryModelId(provider: ProviderConfig): string {
  const modelId = provider.modelIds[0];
  if (!modelId) throw new Error(`供应商 ${provider.name} 没有可用模型`);
  return modelId;
}

async function getHarness(provider: ProviderConfig): Promise<HarnessBundle> {
  let bundle = harnesses.get(provider.id);
  if (!bundle) {
    bundle = (async (): Promise<HarnessBundle> => {
      const registry = createRegistry();
      registry.install({ name: 'resprout', tasks: [AnswerTask] });
      registry.install(SearchExtension);
      const models = createProviderModels(provider, primaryModelId(provider));
      const storage = await openNodeJsonlStorage(resolve(durableRoot, encodeURIComponent(provider.id)), BACKGROUND_CONTEXT);
      const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, storage };
    })();
    harnesses.set(provider.id, bundle);
  }
  return bundle;
}

async function rootFor(harness: HarnessInstance, provider: ProviderConfig) {
  return harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: {
        provider: provider.kind === 'deepseek' ? 'deepseek' : provider.id,
        modelId: primaryModelId(provider),
      },
    },
  });
}

function outcomeErrorMessage(outcome: TaskOutcome<AnswerResult> | undefined): string {
  return outcome && 'error' in outcome && outcome.error ? outcome.error.message : '';
}

async function submitLegacyAnswer(
  provider: ProviderConfig,
  modelId: string,
  sessionId: string,
  requestId: string,
  messages: Message[],
  quickAction: boolean,
  webSearch: boolean,
): Promise<AnswerResult> {
  const { harness } = await getHarness(provider);
  const root = await rootFor(harness, provider);
  const indexKey = `${sessionId}:${requestId}`;
  const { taskId } = await harness.commit(async tx => {
    const index = await tx.doc(RunIndexDoc, indexKey, null);
    if (index.taskId) return { taskId: index.taskId };
    const created = await tx.createTask(AnswerTask, {
      providerId: provider.id,
      modelId,
      sessionId,
      requestId,
      messages,
      quickAction,
      webSearch,
    }, { ownership: { kind: 'conversation' }, conversationId: root.id });
    index.taskId = created;
    index.sessionId = sessionId;
    index.requestId = requestId;
    return { taskId: created };
  }, BACKGROUND_CONTEXT);
  const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  const outcome = settled.state.outcome;
  if (outcome.status !== 'completed') {
    throw new Error(outcomeErrorMessage(outcome) || `回答任务未成功：${outcome.status}`);
  }
  return outcome.result;
}

function contextWindowFor(provider: ProviderConfig, modelId: string): number {
  return provider.kind === 'deepseek'
    ? deepseekModels.getModel('deepseek', modelId)?.contextWindow ?? 128000
    : provider.modelContexts?.[modelId] ?? 128000;
}

function compactionFor(provider: ProviderConfig, modelId: string): CompactionSettings {
  const contextWindow = contextWindowFor(provider, modelId);
  return {
    enabled: true,
    reserveTokens: Math.max(1, Math.floor(contextWindow * 0.15)),
    keepRecentTokens: Math.max(1, Math.floor(contextWindow * 0.35)),
    backgroundTokens: Math.max(1, Math.floor(contextWindow * 0.2)),
  };
}

function agentFor(
  provider: ProviderConfig,
  modelId: string,
  quickAction: boolean,
  webSearch: boolean,
): AgentChange {
  const instructions = [
    quickAction ? QUICK_ACTION_SYSTEM_PROMPT : '',
    webSearch ? SEARCH_SYSTEM_PROMPT : '',
  ].filter(Boolean).join('\n\n');
  return {
    model: { provider: provider.kind === 'deepseek' ? 'deepseek' : provider.id, modelId },
    extensions: webSearch ? [SearchExtension] : [],
    maxTurns: MAX_TOOL_ROUNDS,
    compaction: compactionFor(provider, modelId),
    ...(instructions ? { instructions } : {}),
  };
}

async function createConversation(
  harness: HarnessInstance,
  input: DurableChatInput,
): Promise<Conversation | null> {
  const { provider, modelId, sessionId, parentRequestId, quickAction = false, webSearch = false } = input;
  const agent = agentFor(provider, modelId, quickAction, webSearch);
  if (!parentRequestId) {
    return harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, BACKGROUND_CONTEXT);
  }
  const parentIndex = await harness.snapshot(RunIndexDoc, `${sessionId}:${parentRequestId}`, BACKGROUND_CONTEXT);
  if (!parentIndex?.conversationId || !parentIndex.answerEntryId) return null;
  const parent = await harness.conversation(parentIndex.conversationId, BACKGROUND_CONTEXT);
  if (!parent) return null;
  return parent.fork(parentIndex.answerEntryId, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND_CONTEXT);
}

function inputContent(input: DurableChatInput): UserInput {
  if (input.conversationContent) return input.conversationContent;
  const latest = input.messages.findLast(message => message.role === 'user');
  if (!latest) throw new Error('没有可提交的用户问题');
  return latest.content;
}

async function readAnswer(conversation: Conversation, answerEntryId: EntryId): Promise<AnswerResult> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const entry = view.entries.find(item => item.id === answerEntryId);
  const message = entry?.model?.find(item => item.role === 'assistant');
  if (!message) throw new Error('会话中没有找到已完成的回答');
  const parts = messageParts(message);
  return { ...parts, stopReason: message.stopReason, usage: message.usage };
}

async function compactIfNeeded(
  harness: HarnessInstance,
  conversation: Conversation,
  provider: ProviderConfig,
  modelId: string,
  result: AnswerResult,
): Promise<void> {
  const contextWindow = contextWindowFor(provider, modelId);
  if (!result.usage || result.usage.totalTokens <= contextWindow * 0.65) return;
  const view = await conversation.context(BACKGROUND_CONTEXT);
  if (view.entries.some(entry => entry.kind === 'pi.compaction')) return;
  try {
    const taskId = await conversation.compact(
      '保留当前学习目标、关键事实、公式、代码和未解决的问题，删除重复内容。',
      BACKGROUND_CONTEXT,
    );
    const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    if (settled.state.outcome.status !== 'completed') return;
    const submissionId = settled.state.outcome.result.submissionId;
    if (submissionId !== undefined) {
      const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
      await submission?.wait(BACKGROUND_CONTEXT);
    }
  } catch {}
}

async function submitConversationAnswer(input: DurableChatInput): Promise<AnswerResult> {
  const { provider, sessionId, requestId } = input;
  const { harness } = await getHarness(provider);
  const indexKey = `${sessionId}:${requestId}`;
  const existing = await harness.snapshot(RunIndexDoc, indexKey, BACKGROUND_CONTEXT);
  if (existing?.taskId) return submitLegacyAnswer(
    provider,
    input.modelId,
    sessionId,
    requestId,
    input.messages,
    input.quickAction ?? false,
    input.webSearch ?? false,
  );

  let conversation: Conversation | undefined;
  if (existing?.conversationId) {
    conversation = await harness.conversation(existing.conversationId, BACKGROUND_CONTEXT);
  }
  if (!conversation && existing) throw new Error('无法恢复已有会话');
  if (!conversation) {
    const created = await createConversation(harness, input);
    if (!created) return submitLegacyAnswer(
      provider,
      input.modelId,
      sessionId,
      requestId,
      input.messages,
      input.quickAction ?? false,
      input.webSearch ?? false,
    );
    conversation = created;
  }

  await attachWatch(requestId, conversation);
  const submissionId = await harness.commit(async tx => {
    const index = await tx.doc(RunIndexDoc, indexKey, null);
    if (index.submissionId) return index.submissionId;
    const id = await conversation.submit(tx, {
      type: 'input',
      content: inputContent(input),
      requestId,
      whenBusy: 'reject',
    });
    index.taskId = null;
    index.sessionId = sessionId;
    index.requestId = requestId;
    index.conversationId = conversation.id;
    index.submissionId = id;
    return id;
  }, BACKGROUND_CONTEXT);
  const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
  if (!submission) throw new Error('无法读取已提交的回答任务');
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== 'done') {
    const detail = typeof settled.detail === 'string' ? settled.detail : settled.reason;
    throw new Error(detail ?? '回答任务未成功');
  }
  const answerEntryId = settled.answer;
  if (!answerEntryId) throw new Error('已完成的回答缺少 answer entry');
  await harness.commit(async tx => {
    const index = await tx.doc(RunIndexDoc, indexKey, null);
    index.answerEntryId = answerEntryId;
  }, BACKGROUND_CONTEXT);
  const result = await readAnswer(conversation, answerEntryId);
  await compactIfNeeded(harness, conversation, provider, input.modelId, result);
  return result;
}

function runResult(task: TaskRecord<JsonValue, JsonValue, AnswerResult>, requestId: string): RunResult {
  const outcome = task.state.outcome;
  const checkpoint = task.state.checkpoint;
  const checkpointText = isRecord(checkpoint) && typeof checkpoint.text === 'string' ? checkpoint.text : '';
  const checkpointThinking = isRecord(checkpoint) && typeof checkpoint.thinking === 'string' ? checkpoint.thinking : '';
  const result: Partial<AnswerResult> = outcome?.result ?? {};
  return {
    requestId,
    status: outcome ? outcome.status === 'completed' ? 'done' : 'failed' : 'running',
    text: result.text ?? checkpointText,
    thinking: result.thinking ?? checkpointThinking,
    stopReason: result.stopReason ?? null,
    usage: result.usage ?? null,
    error: outcomeErrorMessage(outcome) || (outcome?.status === 'aborted' ? '回答已中止' : ''),
  };
}

function readId<T extends Id<string>>(value: unknown): T | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value as T : null;
}

async function conversationRunResult(
  harness: HarnessInstance,
  index: Readonly<RunIndex>,
): Promise<RunResult | null> {
  const conversationId = readId<ConversationId>(index.conversationId);
  const submissionId = readId<SubmissionId>(index.submissionId);
  if (!conversationId || !submissionId) return null;
  const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
  const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
  if (!conversation || !submission) return null;
  const record = await submission.status(BACKGROUND_CONTEXT);
  let result: Partial<AnswerResult> = {};
  if (record.status === 'done') {
    if (!record.answer) throw new Error('已完成的回答缺少 answer entry');
    result = await readAnswer(conversation, record.answer);
  } else {
    const live = await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
    result = messageParts(live?.generation?.message);
  }
  return {
    requestId: index.requestId,
    status: record.status === 'done' ? 'done' : record.status === 'unanswered' ? 'failed' : 'running',
    text: result.text ?? '',
    thinking: result.thinking ?? '',
    stopReason: result.stopReason ?? null,
    usage: result.usage ?? null,
    error: record.status === 'unanswered'
      ? typeof record.detail === 'string' ? record.detail : record.reason
      : '',
  };
}

export async function durableChat(input: DurableChatInput): Promise<AnswerResult> {
  const state = addListener(input.requestId, input.onEvent);
  const runKey = `${input.provider.id}:${input.sessionId}:${input.requestId}`;
  let run = answerRuns.get(runKey);
  if (!run) {
    run = submitConversationAnswer(input);
    answerRuns.set(runKey, run);
  }
  try {
    return await run;
  } finally {
    if (answerRuns.get(runKey) === run) answerRuns.delete(runKey);
    await removeListener(input.requestId, input.onEvent);
    if (state.listeners.size === 0 && state.watch) {
      await state.watch.stop().catch(() => {});
    }
  }
}

export async function reconcileRuns(sessionId: string): Promise<RunResult[]> {
  const runs: RunResult[] = [];
  for (const item of providerState().providers) {
    const modelId = item.modelIds[0];
    if (!modelId) continue;
    const selection = resolveProvider({ providerId: item.id, modelId });
    if (!selection) continue;
    const { provider } = selection;
    const { harness, storage } = await getHarness(provider);
    const page = await storage.scanDocuments({
      scope: { kind: 'session' },
      kind: 'resprout.run',
      at: 'current',
    }, 1000, undefined, BACKGROUND_CONTEXT);
    for (const record of page.items) {
      const stored = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
      if (!stored || !isRecord(stored.value)) continue;
      const index = stored.value as RunIndex;
      if (index.sessionId !== sessionId) continue;
      const taskId = readId<TaskId<AnswerResult>>(index.taskId);
      if (taskId) {
        const task = await harness.getTask(taskId, BACKGROUND_CONTEXT);
        if (task) runs.push(runResult(task, index.requestId));
        continue;
      }
      const result = await conversationRunResult(harness, index);
      if (result) runs.push(result);
    }
  }
  return runs;
}

export async function closeDurable(): Promise<void> {
  for (const state of listeners.values()) {
    if (state.watch) await state.watch.stop().catch(() => {});
  }
  listeners.clear();
  answerRuns.clear();
  const current = [...harnesses.values()];
  harnesses.clear();
  for (const promise of current) {
    try {
      const { harness } = await promise;
      await harness.close(BACKGROUND_CONTEXT);
    } catch {}
  }
}
