const moonshotKimiCodeBaseUrls = new Map([
  ['api.moonshot.cn', 'https://api.kimi.com/coding/v1'],
  ['api.moonshot.ai', 'https://api.kimi.ai/coding/v1'],
]);

export function kimiCodeCredentialIssue({ apiKey, baseUrl } = {}) {
  if (!String(apiKey ?? '').trim().startsWith('sk-kimi-')) return null;
  let hostname;
  try {
    hostname = new URL(String(baseUrl ?? '').trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  const correctedBaseUrl = moonshotKimiCodeBaseUrls.get(hostname);
  if (!correctedBaseUrl) return null;
  return {
    baseUrl: correctedBaseUrl,
    message: `检测到 Kimi Code API Key 与 Moonshot 开放平台地址混用，两套平台的 Key 不通用。请改用 ${correctedBaseUrl}，或更换为 Moonshot 开放平台的 Key`,
  };
}

export function assertKimiCodeCredentialCompatible(input) {
  const issue = kimiCodeCredentialIssue(input);
  if (issue) throw new Error(issue.message);
}
