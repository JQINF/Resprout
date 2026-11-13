import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';

export const deepseekModels = createModels();
deepseekModels.setProvider(deepseekProvider());

const QUICK_ACTION_SYSTEM_PROMPT = '根据用户任务和提供的资料作答。任务中的自我介绍描述的是用户本人，不是助手身份。解释时从知识点本身讲起，使用适合目标读者的词汇、例子和细节。只有用户明确要求角色扮演时，才按指定角色回答。';

function generationPayload(provider, payload, options) {
  if (!options.structuredOutput || !options.schema) return undefined;
  if (provider.kind === 'deepseek') return { ...payload, response_format: { type: 'json_object' } };
  if (provider.kind === 'openai' && new URL(provider.baseUrl).hostname === 'api.openai.com') {
    return { ...payload, response_format: { type: 'json_schema', json_schema: { name: options.schemaName ?? 'resprout_structured', schema: options.schema, strict: false } } };
  }
  return undefined;
}

export function createProviderModels(provider, modelId) {
  if (provider.kind === 'deepseek') return deepseekModels;
  const model = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: false,
    input: provider.modelInputs?.[modelId] ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.modelContexts?.[modelId] ?? 128000,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  const customProvider = createProvider({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    auth: { apiKey: envApiKeyAuth(provider.name, ['RESPROUT_API_KEY']) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(customProvider);
  return models;
}

export function modelStream(provider, modelId, context, signal, maxTokens, options = {}) {
  if (options.quickAction === true) {
    context = { ...context, systemPrompt: QUICK_ACTION_SYSTEM_PROMPT };
  }
  if (provider.kind === 'deepseek' && options.structuredOutput && options.schema) {
    const systemPrompt = [context.systemPrompt, '请输出一个有效的 JSON 对象。'].filter(Boolean).join('\n\n');
    context = { ...context, systemPrompt };
  }
  const streamOptions = {
    signal,
    maxTokens,
    onPayload: (payload, model) => generationPayload(provider, payload, options),
  };
  if (Number.isFinite(options.temperature)) streamOptions.temperature = options.temperature;
  const models = createProviderModels(provider, modelId);
  if (provider.kind === 'deepseek') {
    const catalogModel = models.getModel('deepseek', modelId);
    if (!catalogModel) throw new Error(`pi-ai 当前不支持 DeepSeek 模型：${modelId}`);
    const model = { ...catalogModel, baseUrl: provider.baseUrl };
    return models.stream(model, context, {
      ...streamOptions,
      env: { DEEPSEEK_API_KEY: provider.apiKey },
    });
  }
  const model = models.getModel(provider.id, modelId);
  return models.stream(model, context, {
    ...streamOptions,
    env: { RESPROUT_API_KEY: provider.apiKey },
  });
}
