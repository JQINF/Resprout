const NON_CHAT_MODEL = /(?:^|[-_/:])(embedding|embeddings|embed|rerank|rank|whisper|tts|speech|transcribe|transcription|moderation|dall-e|image|images|imagen|video|veo|clip)(?:$|[-_/:])/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('模型列表响应过大');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function providerError(status, text) {
  let detail = '';
  try {
    const value = JSON.parse(text);
    detail = String(value.error?.message ?? value.message ?? '').trim().slice(0, 240);
  } catch {}
  if (status === 401 || status === 403) return `API Key 无效或没有模型列表权限（HTTP ${status}）${detail ? `：${detail}` : ''}`;
  if (status === 404) return '该供应商没有提供标准模型列表接口，请手动输入模型 ID';
  return `获取模型列表失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

export async function discoverModels({ baseUrl, apiKey }, fetchImpl = fetch) {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const endpoint = new URL(`${normalized}/models`);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Base URL 必须使用 HTTP 或 HTTPS');
  if (!String(apiKey ?? '').trim()) throw new Error('请先填写 API Key');
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json', authorization: `Bearer ${String(apiKey).trim()}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('连接模型服务超时，请检查 Base URL 和网络');
    throw new Error(`无法连接模型服务：${error.message}`);
  }
  const text = await responseText(response);
  if (!response.ok) throw new Error(providerError(response.status, text));
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('供应商返回的模型列表不是有效 JSON');
  }
  const entries = Array.isArray(value) ? value : Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : null;
  if (!entries) throw new Error('无法识别供应商返回的模型列表格式');
  const allIds = [...new Set(entries.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const models = allIds.filter(id => !NON_CHAT_MODEL.test(id)).sort((a, b) => a.localeCompare(b));
  const contexts = {};
  for (const item of entries) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
    const candidates = [
      item.context_length,
      item.context_window,
      item.contextWindow,
      item.max_context_tokens,
      item.max_input_tokens,
      item.input_token_limit,
      item.limits?.context_window,
      item.limits?.max_input_tokens,
    ];
    const contextWindow = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
    if (contextWindow) contexts[item.id] = Math.round(contextWindow);
  }
  const inputs = {};
  for (const item of entries) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
    const capabilities = item.input ?? item.modalities ?? item.capabilities?.input;
    if (!Array.isArray(capabilities)) continue;
    const values = [...new Set(capabilities.filter(value => value === 'text' || value === 'image'))];
    if (values.length) inputs[item.id] = values;
  }
  return {
    models,
    contexts,
    inputs,
    filteredCount: allIds.length - models.length,
  };
}
