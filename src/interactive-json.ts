/**
 * 纯文本/JSON 工具：从模型输出中提取 JSON 对象，以及单次生成的输出 schema。
 *
 * DeepSeek 的 structured output 只保证“输出 JSON 对象”，不执行 schema；
 * 因此宿主必须在本地复核字段完整性，不能把缺字段的输出默认为通过。
 * 不支持严格 structured output 的供应商仍被要求输出同一对象，由
 * `extractJsonObjects` 稳健解析；兼容路径不因此增加格式整理调用。
 */

import { extractInteractivePreview, hasInteractiveHtmlShape, normalizeInteractiveHtml } from './interactive-html.ts';

const MAX_GENERATION_RESPONSE_CHARS = 400_000;
const MAX_GENERATION_HTML_CHARS = 200_000;
const MAX_EXPLANATION_CHARS = 30_000;

export interface InteractiveGenerationOutput {
  html: string;
  explanation: string;
}

export type ParsedInteractiveGenerationOutput =
  | ({ ok: true } & InteractiveGenerationOutput)
  | { ok: false; code: string; message: string; stage: 'generation' | 'repair' };

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * 解析单次生成输出：优先 {html, explanation} JSON 对象；兼容裸 HTML。
 * 解析失败/截断/超限属于确定的生成输出错误，返回具体原因供唯一一次修复使用。
 */
export function parseInteractiveGenerationOutput(
  rawOutput: string,
  stage: 'generation' | 'repair',
): ParsedInteractiveGenerationOutput {
  if (rawOutput.length > MAX_GENERATION_RESPONSE_CHARS) {
    return {
      ok: false,
      code: 'output-oversize',
      message: `模型输出超出大小上限（${rawOutput.length} 字符 > ${MAX_GENERATION_RESPONSE_CHARS}）`,
      stage,
    };
  }
  let html = '';
  let explanation = '';
  const jsonObject = extractJsonObjects(rawOutput).find(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return typeof (value as Record<string, unknown>).html === 'string';
  });
  if (jsonObject && typeof jsonObject === 'object' && !Array.isArray(jsonObject)) {
    html = normalizeInteractiveHtml(textValue(recordValue(jsonObject, 'html')));
    explanation = textValue(recordValue(jsonObject, 'explanation')).slice(0, MAX_EXPLANATION_CHARS);
  } else {
    const normalized = normalizeInteractiveHtml(rawOutput);
    if (hasInteractiveHtmlShape(normalized)) html = normalized;
  }
  if (!html || !hasInteractiveHtmlShape(html)) {
    return {
      ok: false,
      code: 'output-invalid',
      message: '模型输出不是有效 HTML，也不是包含 html 字段的 JSON 对象',
      stage,
    };
  }
  if (html.length > MAX_GENERATION_HTML_CHARS) {
    return {
      ok: false,
      code: 'output-oversize',
      message: `HTML 超出大小上限（${html.length} 字符 > ${MAX_GENERATION_HTML_CHARS}）`,
      stage,
    };
  }
  return { ok: true, html, explanation };
}

export const GENERATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['html', 'explanation'],
  properties: {
    html: { type: 'string', minLength: 1 },
    explanation: { type: 'string' },
  },
};

/**
 * 宽松修补：JSON 字符串字面量内的真实控制字符（换行/回车/制表符）转义。
 * 模型常把多行 HTML 直接写进 JSON 字符串而不转义 \n，严格 JSON.parse 会拒绝；
 * 只处理字符串内部，不影响字符串之外的合法 JSON 空白。
 */
export function escapeJsonControlChars(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
        output += character;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        output += character;
        continue;
      }
      if (character === '"') {
        inString = false;
        output += character;
        continue;
      }
      if (character === '\n') {
        output += '\\n';
        continue;
      }
      if (character === '\r') {
        output += '\\r';
        continue;
      }
      if (character === '\t') {
        output += '\\t';
        continue;
      }
      output += character;
      continue;
    }
    if (character === '"') inString = true;
    output += character;
  }
  return output;
}

/**
 * 从模型文本中按括号深度提取 JSON 对象，跳过 Markdown 围栏与不完整片段。
 * 保持字符串/转义状态机，避免把字符串里的花括号当成对象边界。
 * 严格解析失败时，对字符串内的真实控制字符做一次宽容修补后重试——
 * 否则包含多行 HTML 的输出会整体退回裸 HTML 路径，JSON 转义残留（\"）会破坏页面属性。
 */
export function extractJsonObjects(input: unknown): unknown[] {
  const values: unknown[] = [];
  const text = String(input ?? '').replace(/```(?:json)?/gi, '');
  let start = -1;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (string) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"' && depth) string = true;
    else if (character === '{') {
      if (!depth) start = index;
      depth += 1;
    } else if (character === '}' && depth) {
      depth -= 1;
      if (!depth) {
        const slice = text.slice(start, index + 1);
        try {
          const value: unknown = JSON.parse(slice);
          values.push(value);
        } catch {
          try {
            const value: unknown = JSON.parse(escapeJsonControlChars(slice));
            values.push(value);
          } catch {
            // 跳过无法解析的 JSON 片段
          }
        }
      }
    }
  }
  return values;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(textValue).filter(Boolean);
}

/**
 * 从流式累积输出中提取可展示的 HTML 预览：优先取完整 JSON 对象里的 html，
 * 否则尝试解析未完成的 `"html":"` 字符串前缀（处理转义），最后退回裸 HTML。
 */
export function extractGenerationPreview(output: string): string {
  const text = String(output ?? '');
  for (const value of extractJsonObjects(text)) {
    if (!isRecord(value)) continue;
    const html = textValue(recordHtml(value));
    if (html) return extractInteractivePreview(html);
  }
  const marker = text.match(/"html"\s*:\s*"/s);
  if (marker && marker.index !== undefined) {
    let index = marker.index + marker[0].length;
    let raw = '';
    while (index < text.length) {
      const character = text.charAt(index);
      if (character === '"') break;
      if (character === '\\' && index + 1 < text.length) {
        const next = text.charAt(index + 1);
        if (next === 'u' && /[0-9a-f]{4}/i.test(text.slice(index + 2, index + 6))) {
          raw += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
          index += 6;
          continue;
        }
        raw += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 2;
        continue;
      }
      raw += character;
      index += 1;
    }
    const preview = extractInteractivePreview(raw);
    if (preview) return preview;
  }
  return extractInteractivePreview(text);
}

function recordHtml(value: Record<string, unknown>): unknown {
  return value.html;
}
