/**
 * HTML 规范化、预览提取与稳定哈希（纯函数，可在 Node 单测中直接使用）。
 */

export function normalizeInteractiveHtml(input: unknown): string {
  let text = String(input ?? '').trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = text.search(/<!doctype[\s>]|<html[\s>]|<main[\s>]|<section[\s>]|<div[\s>]|<canvas[\s>]|<svg[\s>]|<script[\s>]|<style[\s>]/i);
  if (start > 0) text = text.slice(start);
  const lower = text.toLowerCase();
  const htmlEnd = lower.lastIndexOf('</html>');
  if (htmlEnd >= 0) return text.slice(0, htmlEnd + '</html>'.length).trim();
  const mainEnd = lower.lastIndexOf('</main>');
  if (mainEnd < 0) return text.trim();
  const mainCloseEnd = mainEnd + '</main>'.length;
  const trailing = text.slice(mainCloseEnd);
  if (!/<(?:script|style)\b/i.test(trailing)) return text.slice(0, mainCloseEnd).trim();
  const scriptEnd = lower.lastIndexOf('</script>');
  const styleEnd = lower.lastIndexOf('</style>');
  const contentEnd = Math.max(
    mainCloseEnd,
    scriptEnd >= 0 ? scriptEnd + '</script>'.length : 0,
    styleEnd >= 0 ? styleEnd + '</style>'.length : 0,
  );
  return text.slice(0, contentEnd).trim();
}

export function extractInteractivePreview(output: string): string {
  const html = normalizeInteractiveHtml(output);
  return /<(?:html|main|section|div|canvas|svg)\b/i.test(html) ? html : '';
}

/**
 * 稳定的 64 位内容指纹（两个 32 位 FNV 变体 + 长度），用于候选/验收结果复用。
 * 只用于区分内容，不用于安全用途。
 */
export function hashText(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code;
    second = Math.imul(second, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}${input.length.toString(16)}`;
}

export function hasInteractiveHtmlShape(content: string): boolean {
  return /<(?:html|main|section|div|canvas|svg)\b/i.test(content);
}
