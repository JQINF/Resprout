/**
 * 回答卡片的 Markdown 数学规范化（纯文本层，无 React/CSS 依赖，可在 Node 单测直接运行）。
 *
 * - 模型常用代码围栏或行内代码写公式（或示意图）；这里把“像数学”的代码转成 $/$$ 交给
 *   KaTeX，把 `$$`、`\(...\)` 等形态统一为 remark-math 可识别的分隔符。
 * - 示意图（坐标轴/表格线/箭头流程等含制表符画图字符）绝不能转给 KaTeX——整段图会被
 *   当作数学式解析失败并以红色源码输出（“红色乱码”）。
 */

export const unicodeMathPattern = /(?<![A-Za-z0-9_])(?:[A-Za-z]+\([^()\n]*(?:\p{Script=Greek}|[_^])[^()\n]*\)|[A-Za-z\p{Script=Greek}](?:[_^](?:\{[^{}\n]+\}|[A-Za-z0-9\p{Script=Greek}]+))+(?:\([^()\n]*\))?|[\p{Script=Greek}ℝℕℤℚℂ∑∏∫√∞±≤≥≠≈∈∂∇→])(?![A-Za-z0-9_])/gu;

export function looksLikeMath(value: string): boolean {
  const text = value.trim();
  return /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|log|ln|exp|sin|cos|tan|mean|mathbb|mathcal|mathbf|mathrm|operatorname|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|ldots|cdots|cdot|times|leq|geq|neq|in|subset|infty|partial|nabla)\b/.test(text)
    || /[_^]\{[^{}\n]+\}/.test(text)
    || /(?:\b[A-Za-z][_^][A-Za-z0-9]+\b.*){2}/s.test(text) && /[=+\-*/∑∏√]/.test(text)
    || /^[A-Za-z][_^][A-Za-z0-9]+$/.test(text)
    || /^(?:[A-Za-z]|log|ln|exp|sin|cos|tan|min|max|mean|std|clip)\([^()\n]*\)$/.test(text)
    || /\b[A-Za-z][_^][A-Za-z0-9]+\b/.test(text) && /[=+\-*/|≈<>≤≥]/.test(text)
    || /[\p{Script=Greek}ℝℕℤℚℂ∑∏∫√∞±≤≥≠≈∈∂∇→]/u.test(text);
}

export function looksLikeCode(value: string): boolean {
  return /\b(?:const|let|var|function|return|class|import|export|def|print|public|private|static|if|else|for|while|switch|throw|try|catch|new)\b/.test(value)
    || /;[ \t]*(?:\n|$)/.test(value);
}

// ASCII / 文本示意图（坐标轴、表格线、箭头流程等）：含制表符画图字符，不能转给 KaTeX。
const diagramPattern = /[│┃┆┊┄┅═─━┌┐└┘├┤┼┬┴┮┯╱╲▔▁▂▃▅▆←→↑↓]/;

export function looksLikeDiagram(value: string): boolean {
  return diagramPattern.test(value);
}

export function normalizeMathSyntax(content: string): string {
  return content.replace(
    /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)|(`+)([^`\n]+?)\6(?!`)|\\\(([\s\S]*?)\\\)|([ \t]*)\\\[([\s\S]*?)\\\]/g,
    (
      match: string,
      leading: string,
      _indent: string,
      fence: string | undefined,
      info: string | undefined,
      code: string | undefined,
      inlineFence: string | undefined,
      inlineCode: string | undefined,
      inlineMath: string | undefined,
      displayIndent: string | undefined,
      displayMath: string | undefined,
    ): string => {
      if (inlineFence) {
        if (inlineCode === undefined) return match;
        return looksLikeMath(inlineCode) && !looksLikeCode(inlineCode) && !looksLikeDiagram(inlineCode) ? `$${inlineCode.trim()}$` : match;
      }
      if (inlineMath !== undefined) return `$${inlineMath.trim()}$`;
      if (displayMath !== undefined) {
        const indent = displayIndent ?? '';
        if (!displayMath.includes('\n')) return `${indent}$$\n${indent}${displayMath.trim()}\n${indent}$$`;
        return `${indent}$$${displayMath}$$`;
      }
      if (fence === undefined || code === undefined) return match;
      const language = (info ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      if (['math', 'latex', 'tex'].includes(language) || (!language && looksLikeMath(code) && !looksLikeCode(code) && !looksLikeDiagram(code))) {
        return `${leading}$$\n${code.trim()}\n$$`;
      }
      return match;
    },
  );
}

export function normalizeMathSource(value: string): string {
  return value.trim()
    .replace(/([_^])([A-Za-z0-9]+)/g, '$1{$2}')
    .replace(/~/g, '\\sim ');
}

export function normalizeMarkdown(content: string): string {
  const normalized = content.replace(
    /(^|[\s([{（【])\$(\d+(?:\.\d+)?)(\s+(?:and|or|和|与|或|到|至)\s+|\s*(?:,|，|-|–|—)\s*)\$(?=\d)/gi,
    (_match: string, leading: string, amount: string, separator: string): string => `${leading}\\$${amount}${separator}\\$`,
  );
  return normalizeMathSyntax(normalized)
    .replace(/\*\*((?:[^*\n]|\*(?!\*))*?\S)\*\*/g,
      (match: string, _content: string, offset: number, source: string): string =>
        /[\p{L}\p{N}]/u.test(source[offset + match.length] ?? '') ? `${match} ` : match)
    .replace(/__((?:[^_\n]|_(?!_))*?\S)__/g,
      (match: string, _content: string, offset: number, source: string): string =>
        /[\p{L}\p{N}]/u.test(source[offset + match.length] ?? '') ? `${match} ` : match);
}
