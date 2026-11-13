import { isValidElement, memo, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Paragraph, Root, Text as MdastText } from 'mdast';
import type { InlineMath, Math as MathNode } from 'mdast-util-math';
import type { Node as UnistNode } from 'unist';
import type { Plugin } from 'unified';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

interface AstParent extends UnistNode {
  children: UnistNode[];
}

interface MarkdownContentProps {
  content: string;
  fitMath?: boolean;
}

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item: ReactNode) => textContent(item)).join('');
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return value.props.children ? textContent(value.props.children) : '';
  }
  return '';
}

function CodeBlock({ children }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const [label, setLabel] = useState('复制');
  async function copy() {
    try {
      await navigator.clipboard.writeText(textContent(children));
      setLabel('已复制');
    } catch {
      setLabel('复制失败');
    }
    setTimeout(() => setLabel('复制'), 1600);
  }
  return (
    <div className="code-block">
      <button type="button" className="copy-code nodrag" onClick={copy}>{label}</button>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownTable({ children }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
  return <div className="table-wrap"><table>{children}</table></div>;
}

function MarkdownLink({ children, href }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

const components: Components = {
  pre: CodeBlock,
  table: MarkdownTable,
  a: MarkdownLink,
};

function FittedMath({ children, ...props }: ComponentPropsWithoutRef<'span'> & ExtraProps) {
  const mathRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const element = mathRef.current;
    if (!element) return;
    const container = element.closest('.katex-display')
      ?? element.closest('p, pre, blockquote, li, h1, h2, h3, h4, td, th')
      ?? element.parentElement;
    if (!container) return;

    const fit = () => {
      element.style.removeProperty('font-size');
      const range = document.createRange();
      range.selectNodeContents(element);
      const naturalWidth = range.getBoundingClientRect().width;
      range.detach();
      const availableWidth = container.getBoundingClientRect().width;
      if (!naturalWidth || !availableWidth) return;
      const scale = Math.min(1, availableWidth / naturalWidth);
      if (scale < 1) element.style.fontSize = `${1.21 * scale}em`;
    };

    let observedWidth = container.clientWidth;
    const resizeObserver = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - observedWidth) < 0.5) return;
      observedWidth = width;
      fit();
    });
    const mutationObserver = new MutationObserver(fit);
    resizeObserver.observe(container);
    mutationObserver.observe(element, { childList: true, subtree: true, characterData: true });
    fit();
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return <span {...props} ref={mathRef}>{children}</span>;
}

function FittedMathSpan({ node, ...props }: ComponentPropsWithoutRef<'span'> & ExtraProps) {
  void node;
  if (props.className !== 'katex') return <span {...props} />;
  return <FittedMath {...props} />;
}

const fittedComponents: Components = { ...components, span: FittedMathSpan };

const unicodeMathPattern = /(?<![A-Za-z0-9_])(?:[A-Za-z]+\([^()\n]*(?:\p{Script=Greek}|[_^])[^()\n]*\)|[A-Za-z\p{Script=Greek}](?:[_^](?:\{[^{}\n]+\}|[A-Za-z0-9\p{Script=Greek}]+))+(?:\([^()\n]*\))?|[\p{Script=Greek}ℝℕℤℚℂ∑∏∫√∞±≤≥≠≈∈∂∇→])(?![A-Za-z0-9_])/gu;

function looksLikeMath(value: string): boolean {
  const text = value.trim();
  return /\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|log|ln|exp|sin|cos|tan|mean|mathbb|mathcal|mathbf|mathrm|operatorname|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|phi|omega|ldots|cdots|cdot|times|leq|geq|neq|in|subset|infty|partial|nabla)\b/.test(text)
    || /[_^]\{[^{}\n]+\}/.test(text)
    || /(?:\b[A-Za-z][_^][A-Za-z0-9]+\b.*){2}/s.test(text) && /[=+\-*/∑∏√]/.test(text)
    || /^[A-Za-z][_^][A-Za-z0-9]+$/.test(text)
    || /^(?:[A-Za-z]|log|ln|exp|sin|cos|tan|min|max|mean|std|clip)\([^()\n]*\)$/.test(text)
    || /\b[A-Za-z][_^][A-Za-z0-9]+\b/.test(text) && /[=+\-*/|≈<>≤≥]/.test(text)
    || /[\p{Script=Greek}ℝℕℤℚℂ∑∏∫√∞±≤≥≠≈∈∂∇→]/u.test(text);
}

function looksLikeCode(value: string): boolean {
  return /\b(?:const|let|var|function|return|class|import|export|def|print|public|private|static|if|else|for|while|switch|throw|try|catch|new)\b/.test(value)
    || /;[ \t]*(?:\n|$)/.test(value);
}

function normalizeMathSyntax(content: string): string {
  return content.replace(
    /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*([^\n`]*)\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)|(`+)([^`\n]+?)\6(?!`)|\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g,
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
      displayMath: string | undefined,
    ): string => {
      if (inlineFence) {
        if (inlineCode === undefined) return match;
        return looksLikeMath(inlineCode) && !looksLikeCode(inlineCode) ? `$${inlineCode.trim()}$` : match;
      }
      if (inlineMath !== undefined) return `$${inlineMath.trim()}$`;
      if (displayMath !== undefined) return `$$\n${displayMath.trim()}\n$$`;
      if (fence === undefined || code === undefined) return match;
      const language = (info ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      if (['math', 'latex', 'tex'].includes(language) || (!language && looksLikeMath(code) && !looksLikeCode(code))) {
        return `${leading}$$\n${code.trim()}\n$$`;
      }
      return match;
    },
  );
}

function normalizeMathSource(value: string): string {
  return value.trim()
    .replace(/([_^])([A-Za-z0-9]+)/g, '$1{$2}')
    .replace(/~/g, '\\sim ');
}

function normalizeMathNode(node: MathNode | InlineMath): void {
  node.value = normalizeMathSource(node.value);
  const target = node.data?.hChildren?.[0];
  if (target?.type === 'text') target.value = node.value;
  if (target?.type === 'element' && target.tagName === 'code') {
    target.children = [{ type: 'text', value: node.value }];
  }
}

function isParent(node: UnistNode): node is AstParent {
  return 'children' in node && Array.isArray(node.children);
}

function isParagraph(node: UnistNode): node is Paragraph {
  return node.type === 'paragraph';
}

function isText(node: UnistNode): node is MdastText {
  return node.type === 'text';
}

function isMathNode(node: UnistNode): node is MathNode | InlineMath {
  return node.type === 'math' || node.type === 'inlineMath';
}

const remarkBareMath: Plugin<[], Root> = () => (tree: Root): void => {
  function visit(parent: AstParent): void {
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index];
      if (!child) continue;
      if (isParagraph(child) && child.children.length === 1) {
        const text = child.children[0];
        if (text && isText(text)) {
          const value = text.value.trim();
          const startsWithMath = /^(?:\\|[A-Za-z](?:\s*[=^_]|\())/.test(value);
          if (value && startsWithMath && /\\[A-Za-z]+/.test(value) && !/[`$]/.test(value) && !/\p{Script=Han}/u.test(value) && !looksLikeCode(value)) {
            const mathNode: MathNode = {
              type: 'math',
              value,
              data: {
                hName: 'pre',
                hChildren: [{
                  type: 'element',
                  tagName: 'code',
                  properties: { className: ['language-math', 'math-display'] },
                  children: [{ type: 'text', value }],
                }],
              },
            };
            parent.children[index] = mathNode;
            continue;
          }
        }
      }
      if (isParent(child)) visit(child);
    }
  }
  visit(tree);
};

function splitUnicodeMath(value: string): Array<MdastText | InlineMath> | null {
  const nodes: Array<MdastText | InlineMath> = [];
  let end = 0;
  for (const match of value.matchAll(unicodeMathPattern)) {
    const rawMatch = match[0];
    if (!rawMatch) continue;
    const math = normalizeMathSource(rawMatch);
    if (match.index > end) nodes.push({ type: 'text', value: value.slice(end, match.index) });
    nodes.push({
      type: 'inlineMath',
      value: math,
      data: {
        hName: 'code',
        hProperties: { className: ['language-math', 'math-inline'] },
        hChildren: [{ type: 'text', value: math }],
      },
    });
    end = match.index + rawMatch.length;
  }
  if (!nodes.length) return null;
  if (end < value.length) nodes.push({ type: 'text', value: value.slice(end) });
  return nodes;
}

const remarkUnicodeMath: Plugin<[], Root> = () => (tree: Root): void => {
  function visit(parent: AstParent): void {
    for (let index = 0; index < parent.children.length; index += 1) {
      const child = parent.children[index];
      if (!child) continue;
      if (isMathNode(child)) {
        normalizeMathNode(child);
        continue;
      }
      if (!isText(child)) {
        if (isParent(child)) visit(child);
        continue;
      }
      const replacement = splitUnicodeMath(child.value);
      if (replacement) {
        parent.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    }
  }
  visit(tree);
};

function normalizeMarkdown(content: string): string {
  const normalized = content.replace(
    /(^|[\s([{（【])\$(\d+(?:\.\d+)?)(\s+(?:and|or|和|与|或|到|至)\s+|\s*(?:,|，|-|–|—)\s*)\$(?=\d)/gi,
    (_match: string, leading: string, amount: string, separator: string): string => `${leading}\\$${amount}${separator}\\$`,
  );
  return normalizeMathSyntax(normalized).replace(/(\*\*|__)([^\n]*?\S)\1(?=[\p{L}\p{N}])/gu, '$1$2$1 ');
}

function MarkdownContent({ content, fitMath = false }: MarkdownContentProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkBareMath, remarkUnicodeMath]} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={fitMath ? fittedComponents : components}>
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownContent);
