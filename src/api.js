async function responseError(response) {
  try {
    const value = await response.json();
    return value.error ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

export function getProviders() {
  return request('/api/providers');
}

export function discoverProviderModels(input) {
  return request('/api/providers/models', { method: 'POST', body: JSON.stringify(input) });
}

export function saveProviderRequest(input) {
  return request('/api/providers', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteProviderRequest(id) {
  return request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function activateProviderRequest(input) {
  return request('/api/providers/active', { method: 'POST', body: JSON.stringify(input) });
}

export function reconcileRunsRequest(sessionId) {
  return request('/api/runs/reconcile', { method: 'POST', body: JSON.stringify({ sessionId }) });
}

export function getSearchConfig() {
  return request('/api/search-config');
}

export function saveSearchConfigRequest(input) {
  return request('/api/search-config', { method: 'POST', body: JSON.stringify(input) });
}

export async function streamChat(messages, onEvent, model = null, options = {}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, providerId: model?.providerId, modelId: model?.modelId, options }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error('浏览器不支持流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.type === 'error') throw new Error(event.error);
      onEvent(event);
    }
  }
}
