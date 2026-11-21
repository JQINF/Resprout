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
import { looksLikeCode, looksLikeDiagram, normalizeMarkdown, normalizeMathSource, unicodeMathPattern } from './markdown-normalize.ts';
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
          if (value && startsWithMath && /\\[A-Za-z]+/.test(value) && !/[`$]/.test(value) && !/\p{Script=Han}/u.test(value) && !looksLikeCode(value) && !looksLikeDiagram(value)) {
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
