import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, defineDocFamily, defineTask, Harness } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { resolve } from 'node:path';
import { modelStream, createProviderModels } from './model-stream.mjs';
import { streamAnswer } from './agent-loop.mjs';
import { providerState, resolveProvider } from './provider-store.mjs';

const durableRoot = resolve(process.env.RESPROUT_CONFIG_DIR ?? '.resprout', 'durable');
const harnesses = new Map();
const listeners = new Map();

function emit(requestId, event) {
  for (const listener of listeners.get(requestId) ?? []) {
    try { listener(event); } catch {}
  }
}

const RunIndexDoc = defineDocFamily({
  kind: 'resprout.run',
  scope: 'session',
  family: true,
  version: 1,
  initial: () => ({ taskId: null, sessionId: '', requestId: '' }),
  checkpointWhen: () => false,
});

const AnswerTask = defineTask({
  name: 'resprout.answer',
  version: 1,
  initial: () => ({ phase: 'run', text: '', thinking: '' }),
  phases: {
    run: async (task, runtime, context) => {
      const { providerId, modelId, requestId, messages, quickAction, webSearch } = task.input;
      let text = '';
      let thinking = '';
      try {
        const { provider } = resolveProvider({ providerId, modelId });
        const result = await streamAnswer({
          provider,
          modelId,
          context: { messages },
          signal: runtime.signal,
          maxTokens: 4096,
          options: { quickAction, webSearch: webSearch === true },
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
          outcome: { status: 'failed', error: { message: error.message } },
        }), context);
      }
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});

async function getHarness(provider) {
  if (!harnesses.has(provider.id)) {
    const promise = (async () => {
      const registry = createRegistry();
      registry.install({ name: 'resprout', tasks: [AnswerTask] });
      const models = createProviderModels(provider, provider.modelIds[0]);
      const storage = await openNodeJsonlStorage(resolve(durableRoot, encodeURIComponent(provider.id)), BACKGROUND_CONTEXT);
      const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, storage };
    })();
    harnesses.set(provider.id, promise);
  }
  return harnesses.get(provider.id);
}

async function rootFor(harness, provider) {
  return harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: provider.kind === 'deepseek' ? 'deepseek' : provider.id, modelId: provider.modelIds[0] } },
  });
}

async function submitAnswer(provider, modelId, sessionId, requestId, messages, quickAction, webSearch) {
  const { harness, storage } = await getHarness(provider);
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
  if (settled.state.outcome.status !== 'completed') {
    throw new Error(settled.state.outcome.error?.message ?? `回答任务未成功：${settled.state.outcome.status}`);
  }
  return settled.state.outcome.result;
}

export async function durableChat({ provider, modelId, sessionId, requestId, messages, quickAction = false, webSearch = false, onEvent }) {
  const current = new Set(listeners.get(requestId) ?? []);
  current.add(onEvent);
  listeners.set(requestId, current);
  try {
    return await submitAnswer(provider, modelId, sessionId, requestId, messages, quickAction, webSearch);
  } finally {
    current.delete(onEvent);
    if (!current.size) listeners.delete(requestId);
  }
}

function runResult(task, requestId) {
  const outcome = task.state.outcome;
  const checkpoint = task.state.checkpoint ?? {};
  const result = outcome?.result ?? {};
  return {
    requestId,
    status: outcome ? outcome.status === 'completed' ? 'done' : 'failed' : 'running',
    text: result.text ?? checkpoint.text ?? '',
    thinking: result.thinking ?? checkpoint.thinking ?? '',
    stopReason: result.stopReason ?? null,
    usage: result.usage ?? null,
    error: outcome?.error?.message ?? (outcome?.status === 'aborted' ? '回答已中止' : ''),
  };
}

export async function reconcileRuns(sessionId) {
  const runs = [];
  for (const item of providerState().providers) {
    const { provider } = resolveProvider({ providerId: item.id, modelId: item.modelIds[0] });
    const { harness, storage } = await getHarness(provider);
    const page = await storage.scanDocuments({
      scope: { kind: 'session' },
      kind: 'resprout.run',
      at: 'current',
    }, 1000, undefined, BACKGROUND_CONTEXT);
    for (const record of page.items) {
      const index = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
      if (!index.value.taskId || index.value.sessionId !== sessionId) continue;
      const task = await harness.getTask(index.value.taskId, BACKGROUND_CONTEXT);
      if (task) runs.push(runResult(task, index.value.requestId));
    }
  }
  return runs;
}

export async function closeDurable() {
  const current = [...harnesses.values()];
  harnesses.clear();
  for (const promise of current) {
    try {
      const { harness } = await promise;
      await harness.close(BACKGROUND_CONTEXT);
    } catch {}
  }
  listeners.clear();
}
