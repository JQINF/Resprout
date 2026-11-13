import type { ModelInputModality } from '@earendil-works/pi-ai';
import { streamAnswer } from './agent-loop.ts';
import { knownProviderInputs, setModelInputs } from './provider-store.ts';
import type { ProviderConfig } from './provider-store.ts';

const PROBE_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedImageError(error: unknown): boolean {
  return /image|vision|multimodal|modalit|图片|视觉/i.test(errorMessage(error));
}

export async function detectModelInputs(provider: ProviderConfig, modelId: string): Promise<ModelInputModality[]> {
  const catalogInputs = knownProviderInputs(provider)?.[modelId];
  if (catalogInputs?.includes('image')) return catalogInputs;
  const current = provider.modelInputs?.[modelId] ?? ['text'];
  if (current.includes('image') || provider.modelInputStatus?.[modelId] === 'verified') return current;
  let inputs: ModelInputModality[];
  try {
    const probeProvider: ProviderConfig = {
      ...provider,
      modelInputs: { ...provider.modelInputs, [modelId]: ['text', 'image'] },
    };
    await streamAnswer({
      provider: probeProvider,
      modelId,
      context: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '只回复 OK。' },
            { type: 'image', data: PROBE_IMAGE, mimeType: 'image/png' },
          ],
          timestamp: Date.now(),
        }],
      },
      signal: AbortSignal.timeout(12000),
      maxTokens: 2,
      options: {},
    });
    inputs = ['text', 'image'];
  } catch (error) {
    if (!isUnsupportedImageError(error)) throw error;
    inputs = ['text'];
  }
  await setModelInputs(provider.id, modelId, inputs);
  return inputs;
}
