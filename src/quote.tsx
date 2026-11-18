import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Viewport, XYPosition } from '@xyflow/react';
import { clusterLineRects, textRangeRects, normalizedRangeStart } from './text-selection.ts';
import type { RectLike } from './text-selection.ts';
import { buildQuickActionPrompt, saveQuickActions } from './quick-actions.ts';
import type { QuickAction } from './quick-actions.ts';
import type { Anchor, Highlight } from './session.ts';
import { useStore } from './store.ts';

export type RectBox = RectLike;

export type QuoteSelection = {
  text: string;
  sourceText: string;
  textStart: number;
  anchor: Anchor | null;
  /** 弹出层定位（节点局部 flow 坐标，需按节点当前屏幕位置换算）。 */
  left: number;
  top: number;
  /** 弹出层定位（屏幕像素，fixed 定位直接使用，用于固定面板）。 */
  screenLeft: number;
  screenTop: number;
  /** 内容区局部坐标的选区预览框。 */
  boxes: RectBox[];
};

function closestElement(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

export function mathContentRects(math: Element): RectBox[] {
  const content = math.querySelector('.katex-html');
  const bases = Array.from(content?.children ?? []).filter(element => element.classList.contains('base'));
  const rects = bases.flatMap(base => Array.from(base.getClientRects())
    .filter(rect => rect.width > 0.5 && rect.height > 0.5)
    .map(rect => ({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })));
  const merged = clusterLineRects(rects, Infinity);
  if (merged.length) return merged;
  const range = document.createRange();
  range.selectNodeContents(math);
  return textRangeRects(range, math);
}

export function measureQuoteRects(root: HTMLElement, quote: string, sourceQuote = '', textStart: number | null = null): RectBox[] | null {
  const mathSource = sourceQuote.trim().match(/^\$([\s\S]+)\$$/)?.[1];
  if (mathSource) {
    const math = Array.from(root.querySelectorAll('.katex')).find(element =>
      element.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent === mathSource);
    if (math) return mathContentRects(math);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, node =>
    node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  const nodes: { node: Text; start: number }[] = [];
  let haystack = '';
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) {
      nodes.push({ node, start: haystack.length });
      haystack += node.data;
    }
    node = walker.nextNode();
  }
  const normMap: number[] = [];
  let norm = '';
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack.charAt(i);
    if (/\s/.test(ch) || /[​‌‍﻿]/.test(ch)) continue;
    normMap.push(i);
    norm += ch;
  }
  const normalizedQuote = quote.replace(/[\s​‌‍﻿]/g, '');
  const savedStartMatches = typeof textStart === 'number'
    && Number.isInteger(textStart)
    && norm.slice(textStart, textStart + normalizedQuote.length) === normalizedQuote;
  const normIndex = savedStartMatches && typeof textStart === 'number' ? textStart : norm.indexOf(normalizedQuote);
  if (normIndex < 0 || !normalizedQuote) return null;
  const index = normMap[normIndex];
  const endIndex = normMap[normIndex + normalizedQuote.length - 1];
  if (index === undefined || endIndex === undefined) return null;
  const end = endIndex + 1;
  const range = document.createRange();
  let started = false;
  for (const { node: textNode, start } of nodes) {
    const length = textNode.data.length;
    if (!started && index < start + length) {
      range.setStart(textNode, index - start);
      started = true;
    }
    if (started && end <= start + length) {
      range.setEnd(textNode, end - start);
      const rects = textRangeRects(range, root);
      return rects.length ? rects : null;
    }
  }
  return null;
}

function selectionContentText(node: Node): string {
  if (node instanceof Text) return node.data;
  if (!(node instanceof Element)) {
    return Array.from(node.childNodes).map(selectionContentText).join('');
  }
  if (node.classList.contains('katex-mathml')) return '';
  if (node.classList.contains('katex')) {
    const source = node.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent;
    if (source) return `$${source}$`;
  }
  if (node.tagName === 'BR') return '\n';
  const value = Array.from(node.childNodes).map(selectionContentText).join('');
  return /^(?:P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(node.tagName) ? `${value}\n` : value;
}

function mathForSelection(range: Range, contentEl: HTMLElement): Element | null {
  const selectedMath = Array.from(contentEl.querySelectorAll('.katex')).filter(element => range.intersectsNode(element));
  if (selectedMath.length !== 1) return null;
  const [math] = selectedMath;
  if (!math) return null;
  const normalize = (value: string) => value.replace(/[\s​‌‍﻿]/g, '');
  const selectedText = normalize(range.toString());
  const mathText = normalize(math.querySelector('.katex-html')?.textContent ?? '');
  if (!selectedText) return null;
  if (selectedText === mathText) return math;
  if (selectedText.length !== mathText.length) return null;
  const sortCharacters = (value: string) => Array.from(value).sort().join('');
  return sortCharacters(selectedText) === sortCharacters(mathText) ? math : null;
}

export function selectionSourceText(range: Range, contentEl: HTMLElement, mathElement: Element | null = mathForSelection(range, contentEl)): string {
  if (mathElement) {
    const source = mathElement.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent;
    if (source) return `$${source}$`;
  }
  return selectionContentText(range.cloneContents()).trim();
}

export function QuoteHighlight({ boxes = [], soft }: { boxes?: RectBox[]; soft?: string }) {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map(rect => rect.x));
  const top = Math.min(...boxes.map(rect => rect.y));
  const right = Math.max(...boxes.map(rect => rect.x + rect.w));
  const bottom = Math.max(...boxes.map(rect => rect.y + rect.h));
  const width = right - left;
  const height = bottom - top;
  return (
    <svg
      className="quote-highlight"
      aria-hidden="true"
      style={{ left, top, width, height }}
      viewBox={`0 0 ${width} ${height}`}
    >
      {boxes.map((rect, index) => (
        <rect
          key={index}
          className="quote-highlight-fill"
          x={rect.x - left}
          y={rect.y - top}
          width={rect.w}
          height={rect.h}
          rx={3}
          style={{ fill: soft }}
        />
      ))}
    </svg>
  );
}

type UseQuoteHighlightsOptions = {
  nodeId: string;
  contentRef: RefObject<HTMLElement | null>;
  highlights?: Highlight[];
  content: string;
  pending: boolean;
  /** 为 false 时暂停测量（内容未渲染）。 */
  enabled: boolean;
  /** 覆盖节点根元素（默认取 contentEl 最近的 .react-flow__node），用于固定面板。 */
  getNodeEl?: () => Element | null;
  /** 额外触发重测的计数（如固定面板在视口变化时锚点需重算）。 */
  viewportTick?: number;
};

export function useQuoteHighlights({ nodeId, contentRef, highlights = [], content, pending, enabled, getNodeEl, viewportTick = 0 }: UseQuoteHighlightsOptions): Record<string, RectBox[]> {
  const getViewport = useReactFlow().getViewport;
  const [measureTick, setMeasureTick] = useState(0);
  const [highlightBoxes, setHighlightBoxes] = useState<Record<string, RectBox[]>>({});
  const getNodeElRef = useRef(getNodeEl);
  getNodeElRef.current = getNodeEl;

  const measurementKey = JSON.stringify((highlights ?? []).map(highlight => [
    highlight.id,
    highlight.quote,
    highlight.textStart,
    useStore.getState().edges.find(edge => edge.data?.highlightId === highlight.id)?.data.quote ?? '',
  ]));

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const bump = () => setMeasureTick(tick => tick + 1);
    const onScroll = () => window.requestAnimationFrame(bump);
    contentEl.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(bump);
    observer.observe(contentEl);
    return () => {
      contentEl.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [contentRef, enabled]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!enabled || !contentEl) return;
    if (!highlights.length) {
      setHighlightBoxes(current => Object.keys(current).length ? {} : current);
      return;
    }
    let cancelled = false;
    const measure = (): void => {
      if (cancelled) return;
      const contentRect = contentEl.getBoundingClientRect();
      const zoom = getViewport().zoom || 1;
      // 高亮框定位在内容自身布局坐标系：画布内容随视口缩放，面板内容不缩放（=1）。
      const contentScale = contentRect.width > 0 && contentEl.offsetWidth > 0
        ? contentRect.width / contentEl.offsetWidth
        : zoom;
      const anchorScale = contentScale / zoom;
      const scrollX = contentEl.scrollLeft;
      const scrollY = contentEl.scrollTop;
      const nodeEl = getNodeElRef.current?.() ?? contentEl.closest('.react-flow__node');
      const nodeRect = nodeEl?.getBoundingClientRect();
      const offsetX = nodeRect ? (contentRect.left - nodeRect.left) / zoom : 0;
      const offsetY = nodeRect ? (contentRect.top - nodeRect.top) / zoom : 0;
      const scrollW = contentEl.scrollWidth;
      const scrollH = contentEl.scrollHeight;
      const visTop = scrollY + 6;
      const visBottom = scrollY + contentEl.clientHeight - 6;
      const boxes: Record<string, RectBox[]> = {};
      for (const highlight of highlights) {
        const sourceQuote = useStore.getState().edges.find(edge => edge.data?.highlightId === highlight.id)?.data?.quote ?? '';
        const rects = measureQuoteRects(contentEl, highlight.quote, sourceQuote, highlight.textStart ?? null);
        if (!rects) {
          useStore.getState().updateHighlightAnchor(nodeId, highlight.id, null);
          continue;
        }
        const list = rects.map(rect => {
          let bx = (rect.x - contentRect.left) / contentScale + scrollX - 2;
          let by = (rect.y - contentRect.top) / contentScale + scrollY - 2;
          let bw = rect.w / contentScale + 4;
          let bh = rect.h / contentScale + 4;
          bx = Math.max(1, Math.min(bx, scrollW - 2));
          by = Math.max(1, Math.min(by, scrollH - 2));
          bw = Math.max(4, Math.min(bw, scrollW - 1 - bx));
          bh = Math.max(4, Math.min(bh, scrollH - 1 - by));
          return { x: bx, y: by, w: bw, h: bh };
        });
        boxes[highlight.id] = list;
        const last = list[list.length - 1];
        if (!last) continue;
        const selectionTop = Math.min(...list.map(rect => rect.y));
        const selectionBottom = Math.max(...list.map(rect => rect.y + rect.h));
        const centerY = (selectionTop + selectionBottom) / 2;
        const clampedY = Math.min(Math.max(centerY, visTop), visBottom);
        const nodeWidth = nodeRect ? nodeRect.width / zoom : null;
        useStore.getState().updateHighlightAnchor(nodeId, highlight.id, {
          x: nodeWidth ?? offsetX + (last.x + last.w - scrollX) * anchorScale,
          y: offsetY + (clampedY - scrollY) * anchorScale,
        });
      }
      setHighlightBoxes(boxes);
    };
    if (pending) {
      const timer = setTimeout(measure, 120);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    measure();
    return () => {
      cancelled = true;
    };
  }, [nodeId, content, pending, enabled, measureTick, measurementKey, viewportTick]);

  return highlightBoxes;
}

type BuildQuoteSelectionOptions = {
  eventTarget: EventTarget | null;
  contentEl: HTMLElement;
  nodePosition: XYPosition | null;
  getViewport: () => Viewport;
  screenToFlowPosition: (point: XYPosition) => XYPosition;
};

export function buildQuoteSelection({ eventTarget, contentEl, nodePosition, getViewport, screenToFlowPosition }: BuildQuoteSelectionOptions): QuoteSelection | null {
  if (closestElement(eventTarget, '.quote-popup')) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const text = selection.toString().trim();
  const range = selection.getRangeAt(0);
  if (!text || !contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) return null;
  const mathElement = mathForSelection(range, contentEl);
  const contentRect = contentEl.getBoundingClientRect();
  const zoom = getViewport().zoom || 1;
  const contentScale = contentRect.width > 0 && contentEl.offsetWidth > 0
    ? contentRect.width / contentEl.offsetWidth
    : zoom;
  const scrollX = contentEl.scrollLeft;
  const scrollY = contentEl.scrollTop;
  const clientRects = mathElement ? mathContentRects(mathElement) : textRangeRects(range, contentEl);
  if (!clientRects.length) return null;
  const first = clientRects[0];
  if (!first) return null;
  let anchor: Anchor | null = null;
  if (nodePosition) {
    const lastClient = clientRects[clientRects.length - 1];
    const right = lastClient ? lastClient.x + lastClient.w : range.getBoundingClientRect().right;
    const selectionTop = Math.min(...clientRects.map(rect => rect.y));
    const selectionBottom = Math.max(...clientRects.map(rect => rect.y + rect.h));
    const centerY = (selectionTop + selectionBottom) / 2;
    const point = screenToFlowPosition({ x: right, y: centerY });
    anchor = { x: point.x - nodePosition.x, y: point.y - nodePosition.y };
  }
  const bottomClient = Math.max(...clientRects.map(rect => rect.y + rect.h));
  const toLocal = (rect: RectBox) => ({
    x: (rect.x - contentRect.left) / contentScale + scrollX,
    y: (rect.y - contentRect.top) / contentScale + scrollY,
    w: rect.w / contentScale,
    h: rect.h / contentScale,
  });
  const localRects = clientRects.map(toLocal);
  const firstLocal = localRects[0];
  if (!firstLocal) return null;
  const bottomLocal = Math.max(...localRects.map(rect => rect.y + rect.h));
  const nodeEl = contentEl.closest('.react-flow__node');
  const nodeRect = nodeEl?.getBoundingClientRect();
  const offsetX = nodeRect ? (contentRect.left - nodeRect.left) / zoom : 0;
  const offsetY = nodeRect ? (contentRect.top - nodeRect.top) / zoom : 0;
  const popupLeft = Math.max(12, Math.min(firstLocal.x, contentEl.scrollWidth - 380));
  const result: QuoteSelection = {
    text,
    sourceText: selectionSourceText(range, contentEl, mathElement) || text,
    textStart: normalizedRangeStart(contentEl, range),
    anchor,
    left: offsetX + (popupLeft - scrollX),
    top: offsetY + (bottomLocal - scrollY) + 8 / zoom,
    screenLeft: Math.max(12, Math.min(first.x, window.innerWidth - 392)),
    screenTop: bottomClient + 8,
    boxes: localRects.map(rect => ({
      x: Math.max(1, rect.x - 2),
      y: Math.max(1, rect.y - 2),
      w: rect.w + 4,
      h: rect.h + 4,
    })),
  };
  selection.removeAllRanges();
  return result;
}

export function quotePopupScreenStyle(nodeEl: Element | null, quote: Pick<QuoteSelection, 'left' | 'top'>, getViewport: () => Viewport): CSSProperties {
  if (!nodeEl) return {};
  const rect = nodeEl.getBoundingClientRect();
  const zoom = getViewport().zoom || 1;
  return { left: rect.left + quote.left * zoom, top: rect.top + quote.top * zoom };
}

type QuotePopupProps = {
  style?: CSSProperties;
  className?: string;
  sourceText: string;
  onSubmit(question: string, prompt?: string | null): void;
  onGenerateInteractive(): void;
  onCopy(): void | Promise<void>;
  copyLabel?: string;
};

export function QuotePopup({ style, className, sourceText, onSubmit, onGenerateInteractive, onCopy, copyLabel = '复制文本' }: QuotePopupProps) {
  const quickActions = useStore(state => state.quickActions);
  const setQuickActions = useStore(state => state.setQuickActions);
  const [inputValue, setInputValue] = useState('');
  const [selectionCopied, setSelectionCopied] = useState(false);
  const [actionsEditorOpen, setActionsEditorOpen] = useState(false);
  const [editingActionIndex, setEditingActionIndex] = useState(0);

  function submit() {
    const question = inputValue.trim();
    if (!question) return;
    onSubmit(question);
  }

  async function copySelection() {
    await onCopy();
    setSelectionCopied(true);
    setTimeout(() => setSelectionCopied(false), 1800);
  }

  function updateQuickAction(index: number, patch: Partial<QuickAction>) {
    setQuickActions(actions => actions.map((action, actionIndex) =>
      actionIndex === index ? { ...action, ...patch } : action));
  }

  function removeQuickAction(index: number) {
    setQuickActions(actions => actions.filter((_, actionIndex) => actionIndex !== index));
    setEditingActionIndex(0);
  }

  function addQuickAction() {
    setEditingActionIndex(quickActions.length);
    setQuickActions(actions => [...actions, { id: crypto.randomUUID(), label: '新按钮', prompt: '{text}' }]);
  }

  function closeActionsEditor() {
    saveQuickActions(quickActions);
    setActionsEditorOpen(false);
  }

  return (
    <div
      className={`quote-popup nodrag nowheel${className ? ` ${className}` : ''}`}
      style={style}
      onMouseDown={event => {
        if (!closestElement(event.target, 'input, textarea, [contenteditable="true"]')) event.preventDefault();
      }}
    >
      <div className="surface quote-popup-row">
        <input
          className="quote-input"
          aria-label="追问内容"
          value={inputValue}
          autoFocus
          placeholder="补充说明或提问，Enter 发送"
          onChange={event => setInputValue(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="quote-fixed-actions" role="group" aria-label="固定操作">
          <button
            type="button"
            className="quote-action quote-interactive"
            title="将选中内容生成互动解释"
            onClick={onGenerateInteractive}
          ><PinlessInteractiveIcon />生成交互</button>
          <button
            type="button"
            className="quote-action"
            onClick={() => void copySelection()}
          >{selectionCopied ? '已复制' : copyLabel}</button>
        </div>
      </div>
      <div className="quote-presets" role="group" aria-label="预设与设置">
        {quickActions.map(action => (
          <button
            key={action.id}
            type="button"
            className="quote-action"
            onClick={() => onSubmit(action.label, buildQuickActionPrompt(action, sourceText))}
          >{action.label}</button>
        ))}
        <button
          type="button"
          className={`quote-gear${actionsEditorOpen ? ' is-open' : ''}`}
          aria-label="编辑快捷按钮"
          aria-expanded={actionsEditorOpen}
          onClick={() => setActionsEditorOpen(value => !value)}
        ><PinlessSettingsIcon /></button>
      </div>
      {actionsEditorOpen && (
        <div className="surface quote-actions-editor">
          <div className="qae-title"><span>快捷按钮</span><span>prompt 中 {'{text}'} 表示选中内容</span></div>
          <div className="qae-edit-tip">点击预设输入框，可修改标题并展开提示词</div>
          {quickActions.map((action, index) => (
            <div className={`qae-row${editingActionIndex === index ? ' is-editing' : ''}`} key={action.id}>
              <input
                className="qae-label"
                value={action.label}
                aria-label="预设标题"
                aria-expanded={editingActionIndex === index}
                placeholder="预设标题"
                title="点击修改标题和提示词"
                onFocus={() => setEditingActionIndex(index)}
                onChange={event => updateQuickAction(index, { label: event.target.value })}
              />
              {editingActionIndex === index && (
                <textarea
                  className="qae-prompt"
                  value={action.prompt}
                  aria-label="自定义 prompt"
                  placeholder="自定义 prompt"
                  rows={3}
                  onChange={event => updateQuickAction(index, { prompt: event.target.value })}
                />
              )}
              <button type="button" className="qae-delete" aria-label={`移除预设 ${action.label}`} onClick={() => removeQuickAction(index)}>移除</button>
            </div>
          ))}
          <div className="qae-footer">
            <button type="button" onClick={addQuickAction}>+ 添加按钮</button>
            <button type="button" className="qae-save" onClick={closeActionsEditor}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PinlessInteractiveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 9 5 12 2.5-5.5L22 13Z" />
      <path d="M12 2v3M4.2 4.2l2.1 2.1M2 12h3" />
    </svg>
  );
}

function PinlessSettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
