const moonshotKimiCodeBaseUrls: ReadonlyMap<string, string> = new Map([
  ['api.moonshot.cn', 'https://api.kimi.com/coding/v1'],
  ['api.moonshot.ai', 'https://api.kimi.ai/coding/v1'],
]);

export interface KimiCodeCredentialInput {
  apiKey?: string | null;
  baseUrl?: string | null;
}

export interface KimiCodeCredentialIssue {
  baseUrl: string;
  message: string;
}

export function kimiCodeCredentialIssue({ apiKey, baseUrl }: KimiCodeCredentialInput = {}): KimiCodeCredentialIssue | null {
  if (!String(apiKey ?? '').trim().startsWith('sk-kimi-')) return null;
  let hostname: string;
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

export function assertKimiCodeCredentialCompatible(input: KimiCodeCredentialInput): void {
  const issue = kimiCodeCredentialIssue(input);
  if (issue) throw new Error(issue.message);
}
