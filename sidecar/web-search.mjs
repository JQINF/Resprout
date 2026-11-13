const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';
const MAX_TOOL_OUTPUT_CHARS = 6000;
const SEARCH_TIMEOUT_MS = 20000;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export const SEARCH_TOOLS = [
  {
    name: 'web_search',
    description: `搜索互联网，获取最新信息。支持搜索语法：site:example.com 限定站点、-"短语" 排除、after:2026-01-01 限定时间、lang:zh,en 限定语言。涉及近期事件、版本更新、新闻、你不确定或训练数据之后的事实时，必须调用本工具。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，1~128 字符' },
        count: { type: 'integer', description: '返回条数，1~10，默认 5', minimum: 1, maximum: 10 },
        need_content: { type: 'boolean', description: '是否需要网页正文（更耗 token，默认 false，摘要不够时再用）' },
        time_range: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'], description: '时间范围，默认 any' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: '抓取指定网页的正文（Markdown 格式）。当搜索结果摘要不足以回答，或需要阅读某个具体页面时使用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 http/https 网页地址' },
      },
      required: ['url'],
    },
  },
];

function truncate(value, maximum) {
  const text = String(value ?? '');
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function afterForTimeRange(timeRange) {
  if (timeRange === 'day') return new Date(Date.now() - 24 * 3600 * 1000);
  if (timeRange === 'week') return new Date(Date.now() - 7 * 24 * 3600 * 1000);
  if (timeRange === 'month') return new Date(Date.now() - 30 * 24 * 3600 * 1000);
  if (timeRange === 'year') return new Date(Date.now() - 365 * 24 * 3600 * 1000);
  return null;
}

function lastUserQuestion(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim();
    if (text) return truncate(text.replace(/\s+/g, ' '), 120);
  }
  return null;
}

function statusMessage(status) {
  if (status === 401) return 'DeepSeek API Key 无效（401），请检查搜索配置中的 Key 是否正确';
  if (status === 402) return 'DeepSeek 账号余额不足（402），请前往 platform.deepseek.com 充值后重试';
  if (status === 403) return '请求被安全策略拒绝（403）';
  return `DeepSeek 搜索服务暂时不可用（HTTP ${status}），请稍后重试`;
}

async function request(access, path, body) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${access.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      if (!RETRY_STATUS.has(response.status) || attempt === 1) {
        throw new Error(statusMessage(response.status));
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        if (attempt === 1) throw new Error('DeepSeek 搜索请求超时，请稍后重试');
        lastError = error;
      } else if (error.message?.startsWith('DeepSeek') || error.message?.includes('HTTP')) {
        throw error;
      } else {
        throw new Error(`DeepSeek 搜索请求失败：${error.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw lastError ?? new Error('DeepSeek 搜索请求失败');
}

function formatResult(result, index, withContent) {
  const lines = [
    `${index + 1}. [${result.title ?? '无标题'}](${result.url ?? ''})`,
    `   来源：${result.site_name ?? '未知'}${result.date ? ` · 发布日期：${String(result.date).slice(0, 10)}` : ''}${Number.isFinite(result.authority) && result.authority >= 0 ? ` · 权威度 ${result.authority}/4` : ''}`,
  ];
  if (result.summary) lines.push(`   摘要：${truncate(result.summary, 900)}`);
  else if (result.snippet) lines.push(`   摘要：${truncate(result.snippet, 300)}`);
  if (withContent && result.content) lines.push(`   正文：${truncate(result.content, 1500)}`);
  return lines.join('\n');
}

export async function deepseekSearch(access, args, messages) {
  const query = truncate(String(args.query ?? '').trim(), 128);
  if (!query) return { isError: true, output: '搜索词不能为空' };
  const body = { query };
  const count = Math.min(Math.max(Number.parseInt(args.count, 10) || 5, 1), 10);
  body.count = count;
  body.need_content = args.need_content === true;
  const after = afterForTimeRange(args.time_range);
  if (after) body.query = `${query} after:${after.toISOString().slice(0, 10)}`;
  const oriQuestion = lastUserQuestion(messages);
  if (oriQuestion) body.ori_question = oriQuestion;

  const data = await request(access, SEARCH_PATH, body);
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return { isError: false, output: `没有搜索到与「${query}」相关的结果，请更换关键词或放宽时间范围。` };
  const output = `搜索「${query}」得到 ${results.length} 条结果（按相关度排序）：\n\n`
    + results.slice(0, count).map((result, index) => formatResult(result, index, body.need_content)).join('\n\n')
    + '\n\n回答用户问题时请引用来源 URL；如需更详细内容可用 fetch_page 读取具体页面。';
  return { isError: false, output: truncate(output, MAX_TOOL_OUTPUT_CHARS) };
}

export async function deepseekFetch(access, args) {
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/.test(url)) return { isError: true, output: '无效的网页地址' };
  try {
    const data = await request(access, FETCH_PATH, { url });
    if (!data.content) return { isError: true, output: `未能从 ${url} 提取到正文（页面可能禁止抓取或没有可读内容）` };
    return { isError: false, output: truncate(`# ${data.title ?? url}\n\n${data.content}`, MAX_TOOL_OUTPUT_CHARS) };
  } catch (error) {
    return { isError: true, output: `抓取 ${url} 失败：${error.message}` };
  }
}

export async function runSearchTool(access, name, args, messages) {
  if (name === 'web_search') return deepseekSearch(access, args ?? {}, messages);
  if (name === 'fetch_page') return deepseekFetch(access, args ?? {});
  return { isError: true, output: `未知工具：${name}` };
}

export function searchGuidance() {
  return '联网搜索由 DeepSeek 提供（每 1000 次成功请求约 ¥5，失败不计费）。请填写 DeepSeek API Key 开启，Key 仅保存在本机。获取地址：platform.deepseek.com';
}
