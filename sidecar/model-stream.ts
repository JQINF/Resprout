import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream, Context, CredentialStore, Model, MutableModels, StreamOptions } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { providerModelInputs } from './provider-store.ts';
import type { ProviderConfig } from './provider-store.ts';

export const deepseekModels: MutableModels = createModels();
deepseekModels.setProvider(deepseekProvider());

export const QUICK_ACTION_SYSTEM_PROMPT = '根据用户任务和提供的资料作答。任务中的自我介绍描述的是用户本人，不是助手身份。解释时从知识点本身讲起，使用适合目标读者的词汇、例子和细节。只有用户明确要求角色扮演时，才按指定角色回答。';

export interface ModelStreamOptions {
  quickAction?: boolean;
  structuredOutput?: boolean;
  schema?: unknown;
  schemaName?: string;
  temperature?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function generationPayload(provider: ProviderConfig, payload: unknown, options: ModelStreamOptions): Record<string, unknown> | undefined {
  if (!options.structuredOutput || !options.schema) return undefined;
  const body = isRecord(payload) ? payload : {};
  if (provider.kind === 'deepseek') return { ...body, response_format: { type: 'json_object' } };
  if (provider.kind === 'openai' && new URL(provider.baseUrl).hostname === 'api.openai.com') {
    return {
      ...body,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: options.schemaName ?? 'resprout_structured',
          schema: options.schema,
          strict: false,
        },
      },
    };
  }
  return undefined;
}

function credentialStoreFor(provider: ProviderConfig): CredentialStore {
  const providerId = provider.kind === 'deepseek' ? 'deepseek' : provider.id;
  const credential = { type: 'api_key' as const, key: provider.apiKey };
  return {
    read: async id => id === providerId ? credential : undefined,
    list: async () => [{ providerId, type: 'api_key' as const }],
    modify: async (id, change) => change(id === providerId ? credential : undefined),
    delete: async () => {},
  };
}

export function createProviderModels(provider: ProviderConfig, modelId: string): MutableModels {
  if (provider.kind === 'deepseek') {
    const models = createModels({ credentials: credentialStoreFor(provider) });
    models.setProvider(deepseekProvider());
    return models;
  }
  const modelIds = [...new Set([...provider.modelIds, modelId])];
  const modelList: Model<'openai-completions'>[] = modelIds.map(id => ({
    id,
    name: id,
    api: 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: false,
    input: providerModelInputs(provider, id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.modelContexts?.[id] ?? 128000,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  }));
  const customProvider = createProvider({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    auth: { apiKey: envApiKeyAuth(provider.name, ['RESPROUT_API_KEY']) },
    models: modelList,
    api: openAICompletionsApi(),
  });
  const models = createModels({ credentials: credentialStoreFor(provider) });
  models.setProvider(customProvider);
  return models;
}

export function modelStream(
  provider: ProviderConfig,
  modelId: string,
  context: Context,
  signal: AbortSignal | undefined,
  maxTokens: number,
  options: ModelStreamOptions = {},
): AssistantMessageEventStream {
  let requestContext = context;
  if (options.quickAction === true) {
    requestContext = { ...requestContext, systemPrompt: QUICK_ACTION_SYSTEM_PROMPT };
  }
  if (provider.kind === 'deepseek' && options.structuredOutput && options.schema) {
    const systemPrompt = [requestContext.systemPrompt, '请输出一个有效的 JSON 对象。']
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
    requestContext = { ...requestContext, systemPrompt };
  }
  const streamOptions: StreamOptions = {
    signal,
    maxTokens,
    onPayload: payload => generationPayload(provider, payload, options),
  };
  if (Number.isFinite(options.temperature)) streamOptions.temperature = options.temperature;
  const models = createProviderModels(provider, modelId);
  if (provider.kind === 'deepseek') {
    const catalogModel = models.getModel('deepseek', modelId);
    if (!catalogModel) throw new Error(`pi-ai 当前不支持 DeepSeek 模型：${modelId}`);
    const model = { ...catalogModel, baseUrl: provider.baseUrl, input: providerModelInputs(provider, modelId) };
    return models.stream(model, requestContext, {
      ...streamOptions,
      env: { DEEPSEEK_API_KEY: provider.apiKey },
    });
  }
  const model = models.getModel(provider.id, modelId);
  if (!model) throw new Error(`pi-ai 当前不支持模型：${modelId}`);
  return models.stream(model, requestContext, {
    ...streamOptions,
    env: { RESPROUT_API_KEY: provider.apiKey },
  });
}
