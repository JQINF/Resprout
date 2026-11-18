import type { JsonObject, Tool } from '@earendil-works/pi-ai';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export const FETCH_TOOLS: Tool[] = [
  {
    name: 'fetch_page',
    description: '抓取指定 http/https 网页的正文（自动提取文章主要内容，转为纯文本）。当用户问题里带有链接、或需要阅读某个具体页面时使用。GitHub 仓库链接会读取仓库信息与 README。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http/https 网页地址' },
      },
      required: ['url'],
    },
  },
];

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 24_000;
const MAX_REDIRECTS = 5;

export interface FetchToolResult {
  readonly isError: boolean;
  readonly output: string;
}

export interface FetchRunOptions {
  /** 测试用途：允许抓取本机/内网地址（生产侧不传，默认禁止）。 */
  readonly allowPrivateHosts?: boolean;
}

const LINK_PATTERN = /https?:\/\/[^\s<>"'）)\]]+/i;
const FETCH_INTENT_PATTERN = /(?:去看|看下|查看|查阅|查询|搜索|检索|阅读|调研|研究一下|研究下|look\s+up|research)/i;

// 链接或明确查阅意图都可使用 fetch_page；普通问答不额外挂工具。
export function messagesNeedFetch(messages: readonly { role: string; content: unknown }[]): boolean {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.content;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === 'object' && block !== null && 'type' in block
          && (block as { type?: unknown }).type === 'text' && 'text' in block) {
          texts.push(String((block as { text?: unknown }).text ?? ''));
        }
      }
    }
    if (texts.some(text => LINK_PATTERN.test(text) || FETCH_INTENT_PATTERN.test(text))) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string, maximum = MAX_OUTPUT_CHARS): string {
  return text.length > maximum ? `${text.slice(0, maximum)}…\n（内容过长已截断，共 ${text.length} 字符）` : text;
}

// 内网/本机地址不允许抓取：sidecar 跑在用户机器上，防止模型诱导读取本机服务。
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('127.') || host.startsWith('10.') || host.startsWith('169.254.') || host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith('::ffff:127.') || host.startsWith('::ffff:10.') || host.startsWith('::ffff:192.168.')) return true;
  return false;
}

function normalizeText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\t \u00a0]+/g, ' ').trim());
  const out: string[] = [];
  let blank = false;
  for (const line of lines) {
    if (!line) {
      if (!blank && out.length) blank = true;
      continue;
    }
    blank = false;
    out.push(line);
  }
  return out.join('\n').trim();
}

export interface GitHubRepoTarget {
  readonly kind: 'repo';
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubBlobTarget {
  readonly kind: 'blob';
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly path: string;
}

export type GitHubTarget = GitHubRepoTarget | GitHubBlobTarget;

// 把 GitHub 页面映射到官方 API / raw 地址：HTML 页面是重型前端渲染，直接抓正文效果差。
export function githubTarget(url: URL): GitHubTarget | null {
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  if (parts.length === 2) return { kind: 'repo', owner, repo };
  if (parts[2] === 'blob' && parts.length >= 5 && parts[3]) {
    return { kind: 'blob', owner, repo, ref: parts[3], path: parts.slice(4).join('/') };
  }
  return null;
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('页面超过 4MB，已中止抓取');
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}

async function request(url: string, allowPrivateHosts: boolean): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('仅支持 http/https 链接');
    if (!allowPrivateHosts && isBlockedHost(current.hostname)) throw new Error('不允许访问本机或内网地址');
    if (hop > MAX_REDIRECTS) throw new Error('重定向次数过多');
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'resprout-sidecar/1.0 (+https://github.com/resprout)',
        accept: 'text/html,text/plain,text/markdown,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`重定向缺少目标地址（HTTP ${response.status}）`);
      current = new URL(location, current);
      continue;
    }
    return response;
  }
}

function extractFromHtml(html: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const title = document.querySelector('title')?.textContent?.trim() ?? '';
  try {
    const article = new Readability(document).parse();
    const text = article?.textContent?.trim() ?? '';
    if (text.length > 200) return { title: article?.title?.trim() || title, text: normalizeText(text) };
  } catch {
    // Readability 解析失败时退回整页正文。
  }
  const body = document.body;
  if (!body) return { title, text: '' };
  for (const element of Array.from(body.querySelectorAll('script,style,noscript,iframe,svg,canvas,header,footer,nav,form'))) {
    element.remove();
  }
  return { title, text: normalizeText(body.textContent ?? '') };
}

async function githubRepoPage(target: GitHubRepoTarget): Promise<string> {
  const apiBase = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'resprout-sidecar/1.0',
  };
  const metaResponse = await fetch(apiBase, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!metaResponse.ok) throw new Error(`GitHub 仓库信息获取失败（HTTP ${metaResponse.status}）`);
  const meta: unknown = await metaResponse.json();
  if (!isRecord(meta)) throw new Error('GitHub 返回了无效的仓库信息');
  const readmeResponse = await fetch(`${apiBase}/readme`, {
    headers: { ...headers, accept: 'application/vnd.github.raw+json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const readme = readmeResponse.ok ? normalizeText(await readmeResponse.text()) : '（该仓库没有 README）';
  const topics = Array.isArray(meta.topics) ? meta.topics.map(String).filter(Boolean).join(', ') : '';
  const metaLine = [
    meta.language ? `语言：${String(meta.language)}` : '',
    meta.stargazers_count != null ? `Stars：${String(meta.stargazers_count)}` : '',
    meta.default_branch ? `默认分支：${String(meta.default_branch)}` : '',
    meta.pushed_at ? `最近更新：${String(meta.pushed_at).slice(0, 10)}` : '',
  ].filter(Boolean).join(' · ');
  const sections = [
    `# ${String(meta.full_name ?? `${target.owner}/${target.repo}`)}`,
    `URL: https://github.com/${target.owner}/${target.repo}`,
    `描述：${String(meta.description ?? '（无）')}`,
    metaLine,
    topics ? `主题：${topics}` : '',
  ].filter(Boolean);
  return truncate(`${sections.join('\n')}\n\n## README\n\n${readme || '（README 为空）'}`);
}

async function fetchPage(url: string, allowPrivateHosts = false): Promise<FetchToolResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { isError: true, output: '无效的网页地址' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { isError: true, output: '仅支持 http/https 链接' };
  }
  if (!allowPrivateHosts && isBlockedHost(parsed.hostname)) {
    return { isError: true, output: '不允许访问本机或内网地址' };
  }

  const gh = githubTarget(parsed);
  try {
    if (gh?.kind === 'repo') {
      return { isError: false, output: await githubRepoPage(gh) };
    }
    const fetchUrl = gh?.kind === 'blob'
      ? `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${encodeURIComponent(gh.ref)}/${gh.path.split('/').map(encodeURIComponent).join('/')}`
      : url;
    const response = await request(fetchUrl, allowPrivateHosts);
    if (!response.ok) {
      return { isError: true, output: `抓取失败：HTTP ${response.status}` };
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const body = await readBody(response);
    if (contentType.includes('html') || (!contentType && /<\s*html[\s>]/i.test(body.slice(0, 2000)))) {
      const page = extractFromHtml(body);
      if (!page.text) return { isError: true, output: '未能从页面提取到可读文本（页面可能依赖脚本渲染或没有正文）' };
      const heading = page.title ? `# ${page.title}\n\nURL: ${url}\n\n` : `URL: ${url}\n\n`;
      return { isError: false, output: truncate(`${heading}${page.text}`) };
    }
    if (contentType.startsWith('text/') || contentType === 'application/json' || contentType.includes('markdown')) {
      const text = normalizeText(body);
      if (!text) return { isError: true, output: '页面内容为空' };
      return { isError: false, output: truncate(`URL: ${url}\n\n${text}`) };
    }
    return { isError: true, output: `该链接返回的内容类型（${contentType || '未知'}）不是可读的网页文本；如果是 PDF 或文件，请下载后拖入画布` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('中止')) return { isError: true, output: message };
    return { isError: true, output: `抓取 ${url} 失败：${message}` };
  }
}

export async function runFetchTool(name: string, args: JsonObject | undefined, options: FetchRunOptions = {}): Promise<FetchToolResult> {
  if (name !== 'fetch_page') return { isError: true, output: `未知工具：${name}` };
  const url = String(args?.url ?? '').trim();
  if (!url) return { isError: true, output: 'url 不能为空' };
  return fetchPage(url, options.allowPrivateHosts === true);
}
