import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useOnViewportChange,
  useReactFlow,
} from '@xyflow/react';
import { createPortal } from 'react-dom';
import MarkdownContent from './Markdown.jsx';
import { buildInteractiveDocument } from './interactive-runtime.js';
import ProviderSettings from './Settings.jsx';
import SessionHome from './Home.jsx';
import PDFNode from './PDFNode.jsx';
import NodeResizeCorners from './NodeResizeCorners.jsx';
import NodeCard from './NodeCard.jsx';
import ImageNode from './ImageNode.jsx';
import {
  createSession,
  DEFAULT_ANSWER_SIZE,
  DEFAULT_INTERACTIVE_SIZE,
  DEFAULT_INTERACTIVE_SPLIT_RATIO,
  INTERACTIVE_ASPECT_RATIO,
  exportSession,
  importSession,
  interactiveFreeSize,
  interactiveNodeSize,
} from './session.js';
import { readSessionRecord, saveSessionRecord } from './session-library.js';
import { buildQuickActionPrompt, saveQuickActions } from './quick-actions.js';
import { buildBranchTrees, plainPreview } from './branch-manager.js';
import { readPdfFile } from './pdf-store.js';
import { clusterLineRects, textRangeRects, normalizedRangeStart } from './text-selection.js';
import { useStore } from './store.js';

function mathContentRects(math) {
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

function measureQuoteRects(root, quote, sourceQuote = '', textStart = null) {
  const mathSource = sourceQuote.trim().match(/^\$([\s\S]+)\$$/)?.[1];
  if (mathSource) {
    const math = Array.from(root.querySelectorAll('.katex')).find(element =>
      element.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent === mathSource);
    if (math) return mathContentRects(math);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, node =>
    node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  const nodes = [];
  let haystack = '';
  let node = walker.nextNode();
  while (node) {
    nodes.push({ node, start: haystack.length });
    haystack += node.data;
    node = walker.nextNode();
  }
  const normMap = [];
  let norm = '';
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i];
    if (/\s/.test(ch) || /[\u200b\u200c\u200d\ufeff]/.test(ch)) continue;
    normMap.push(i);
    norm += ch;
  }
  const normalizedQuote = quote.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
  const savedStartMatches = Number.isInteger(textStart)
    && norm.slice(textStart, textStart + normalizedQuote.length) === normalizedQuote;
  const normIndex = savedStartMatches ? textStart : norm.indexOf(normalizedQuote);
  if (normIndex < 0 || !normalizedQuote) return null;
  const index = normMap[normIndex];
  const end = normMap[normIndex + normalizedQuote.length - 1] + 1;
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

function selectionContentText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.data;
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return Array.from(node.childNodes ?? []).map(selectionContentText).join('');
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

function mathForSelection(range, contentEl) {
  const selectedMath = Array.from(contentEl.querySelectorAll('.katex')).filter(element => range.intersectsNode(element));
  if (selectedMath.length !== 1) return null;
  const math = selectedMath[0];
  const normalize = value => value.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
  const selectedText = normalize(range.toString());
  const mathText = normalize(math.querySelector('.katex-html')?.textContent ?? '');
  if (!selectedText) return null;
  if (selectedText === mathText) return math;
  if (selectedText.length !== mathText.length) return null;
  const sortCharacters = value => Array.from(value).sort().join('');
  return sortCharacters(selectedText) === sortCharacters(mathText) ? math : null;
}

function selectionSourceText(range, contentEl, mathElement = mathForSelection(range, contentEl)) {
  if (mathElement) {
    const source = mathElement.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent;
    if (source) return `$${source}$`;
  }
  return selectionContentText(range.cloneContents()).trim();
}

const CHAIN_COLORS = [
  { stroke: '#6f9ec7', soft: 'rgba(111, 158, 199, 0.36)', border: '#c3d2e2', fill: '#f0f5fb' },
  { stroke: '#c79a6f', soft: 'rgba(199, 154, 111, 0.36)', border: '#e2cdb8', fill: '#faf3ec' },
  { stroke: '#9a7fc7', soft: 'rgba(154, 127, 199, 0.36)', border: '#d0c4e4', fill: '#f4effb' },
  { stroke: '#62ad8b', soft: 'rgba(98, 173, 139, 0.36)', border: '#bed9cb', fill: '#edf6f1' },
  { stroke: '#c76f8e', soft: 'rgba(199, 111, 142, 0.36)', border: '#e4c2cf', fill: '#fbeef3' },
];

function chainColorIndex(edges, edge) {
  if (!edge) return -1;
  const colorEdge = edge.data?.highlightId
    ? edges.find(item => item.source === edge.source && item.data?.kind === 'probe' && item.data?.highlightId === edge.data.highlightId) ?? edge
    : edge;
  const probes = edges.filter(item => item.source === colorEdge.source && item.data?.kind === 'probe');
  const index = probes.indexOf(colorEdge);
  return index < 0 ? -1 : index % CHAIN_COLORS.length;
}

function formatNodeTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function QuoteHighlight({ boxes = [], soft }) {
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

function useNodeResizeState() {
  const [resizing, setResizing] = useState(false);
  const onResizeStart = useCallback(() => setResizing(true), []);
  const onResizeEnd = useCallback(() => setResizing(false), []);
  return { resizing, onResizeStart, onResizeEnd };
}

async function copyText(text) {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 800)),
    ]);
    return true;
  } catch {
    try {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      const copied = document.execCommand('copy');
      helper.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function ConversationNode({ id, data, selected, checkpoint = false }) {
  const updateNodeContent = useStore(state => state.updateNodeContent);
  const sendMessage = useStore(state => state.sendMessage);
  const askFromSelection = useStore(state => state.askFromSelection);
  const generateInteractiveFromRequest = useStore(state => state.generateInteractiveFromRequest);
  const generateInteractiveFromSelection = useStore(state => state.generateInteractiveFromSelection);
  const setNodeModel = useStore(state => state.setNodeModel);
  const providers = useStore(state => state.providers);
  const activeProvider = useStore(state => state.activeProvider);
  const quickActions = useStore(state => state.quickActions);
  const setQuickActions = useStore(state => state.setQuickActions);
  const nodePosition = useStore(state => state.nodes.find(node => node.id === id)?.position);
  const edges = useStore(state => state.edges);
  const { getViewport, setCenter, screenToFlowPosition } = useReactFlow();
  const contentRef = useRef(null);
  const questionInputRef = useRef(null);
  const [nodeRootEl, setNodeRootEl] = useState(null);
  const [quoteButton, setQuoteButton] = useState(null);
  const [measureTick, setMeasureTick] = useState(0);
  const [highlightBoxes, setHighlightBoxes] = useState({});
  const [scrollState, setScrollState] = useState({ top: 0, height: 0, visible: false });
  const isAssistant = data.role === 'assistant';
  const selectedModel = data.model ?? activeProvider;
  const selectedModelValue = selectedModel ? `${selectedModel.providerId}::${selectedModel.modelId}` : '';
  const selectedModelAvailable = providers.some(provider => provider.id === selectedModel?.providerId && provider.modelIds.includes(selectedModel?.modelId));
  const answerModelLabel = data.model?.modelId ?? '';
  const kindLabel = isAssistant
    ? `回答${answerModelLabel ? ` · ${answerModelLabel}` : ''}`
    : data.nodeType === 'root' ? '根问题' : data.nodeType === 'interactive' ? '交互' : data.nodeType === 'question' ? '追问' : '问题';
  const incomingProbe = edges.find(edge => edge.target === id && edge.data?.kind === 'probe');
  const parentEdge = edges.find(edge => edge.target === id);
  const grandProbe = parentEdge
    ? edges.find(edge => edge.target === parentEdge.source && edge.data?.kind === 'probe')
    : null;
  const chain = isAssistant
    ? (grandProbe ? CHAIN_COLORS[chainColorIndex(edges, grandProbe)] ?? null : null)
    : (incomingProbe ? CHAIN_COLORS[chainColorIndex(edges, incomingProbe)] ?? null : null);
  const previewChain = CHAIN_COLORS[
    edges.filter(edge => edge.source === id && edge.data?.kind === 'probe').length % CHAIN_COLORS.length
  ] ?? null;
  const highlightChainOf = highlightId => {
    const edge = edges.find(item => item.data?.highlightId === highlightId);
    return edge ? CHAIN_COLORS[chainColorIndex(edges, edge)] ?? null : null;
  };

  useEffect(() => {
    setNodeRootEl(contentRef.current?.closest('.react-flow__node') ?? null);
  }, []);

  const [, setViewportTick] = useState(0);
  useOnViewportChange({
    onChange: () => {
      if (quoteButton) setViewportTick(tick => tick + 1);
    },
  });

  function quotePopupStyle() {
    if (!nodeRootEl || !quoteButton) return {};
    const rect = nodeRootEl.getBoundingClientRect();
    const zoom = getViewport().zoom || 1;
    return {
      left: rect.left + quoteButton.left * zoom,
      top: rect.top + quoteButton.top * zoom,
    };
  }

  function updateScrollState() {
    const el = contentRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const visible = max > 1;
    const height = visible ? Math.max(24, (el.clientHeight / el.scrollHeight) * el.clientHeight) : 0;
    const top = visible ? (el.scrollTop / max) * (el.clientHeight - height) : 0;
    setScrollState({ top, height, visible });
  }

  function onScrollbarMouseDown(event) {
    const el = contentRef.current;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const move = moveEvent => {
      const rect = el.getBoundingClientRect();
      const thumbH = Math.max(24, (el.clientHeight / el.scrollHeight) * el.clientHeight);
      const ratio = (moveEvent.clientY - rect.top - thumbH / 2) / (el.clientHeight - thumbH);
      el.scrollTop = Math.max(0, Math.min(1, ratio)) * (el.scrollHeight - el.clientHeight);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    move(event);
  }
  const [inputValue, setInputValue] = useState('');
  const [selectionCopied, setSelectionCopied] = useState(false);
  const [actionsEditorOpen, setActionsEditorOpen] = useState(false);
  const [editingActionIndex, setEditingActionIndex] = useState(0);
  const [editing, setEditing] = useState(!data.content || Boolean(data.autoFocus));
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const isEdgeQuestion = data.nodeType === 'question';
  const [questionDraft, setQuestionDraft] = useState(() => isEdgeQuestion && !checkpoint && (!data.content || Boolean(data.autoFocus)));
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [questionClosing, setQuestionClosing] = useState(false);
  const questionHoverTimer = useRef(null);
  const questionCloseTimer = useRef(null);
  const questionCollapsed = isEdgeQuestion && !questionDraft && !questionExpanded && Boolean(data.content);
  const { resizing, onResizeStart, onResizeEnd } = useNodeResizeState();

  useEffect(() => {
    if (!editing) return;
    const input = questionInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  useEffect(() => () => {
    clearTimeout(questionHoverTimer.current);
    clearTimeout(questionCloseTimer.current);
  }, []);

  function scheduleQuestionExpansion(event) {
    if (!isEdgeQuestion || questionDraft) return;
    clearTimeout(questionCloseTimer.current);
    setQuestionClosing(false);
    if (questionExpanded) return;
    clearTimeout(questionHoverTimer.current);
    if (event.buttons) return;
    questionHoverTimer.current = setTimeout(() => setQuestionExpanded(true), 240);
  }

  function collapseQuestion() {
    clearTimeout(questionHoverTimer.current);
    if (!isEdgeQuestion || questionDraft || !questionExpanded) return;
    clearTimeout(questionCloseTimer.current);
    setQuestionClosing(true);
    questionCloseTimer.current = setTimeout(() => {
      setQuestionExpanded(false);
      setQuestionClosing(false);
    }, 150);
  }

  async function copyContent() {
    if (!data.content) return;
    const ok = await copyText(data.content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } else {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 3000);
    }
  }

  useEffect(() => {
    if (!quoteButton) return;
    const onDocPointerDown = event => {
      if (!event.target.closest('.quote-popup')) finishQuote();
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') finishQuote();
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [quoteButton]);

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
  }, []);

  useLayoutEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    updateScrollState();
    const highlights = data.highlights ?? [];
    if (!highlights.length) {
      setHighlightBoxes({});
      return;
    }
    const contentRect = contentEl.getBoundingClientRect();
    const zoom = getViewport().zoom || 1;
    const scrollX = contentEl.scrollLeft;
    const scrollY = contentEl.scrollTop;
    const nodeEl = contentEl.closest('.react-flow__node');
    const nodeRect = nodeEl?.getBoundingClientRect();
    const offsetX = nodeRect ? (contentRect.left - nodeRect.left) / zoom : 0;
    const offsetY = nodeRect ? (contentRect.top - nodeRect.top) / zoom : 0;
    const scrollW = contentEl.scrollWidth;
    const scrollH = contentEl.scrollHeight;
    const visTop = scrollY + 6;
    const visBottom = scrollY + contentEl.clientHeight - 6;
    const boxes = {};
    for (const highlight of highlights) {
      const sourceQuote = edges.find(edge => edge.data?.highlightId === highlight.id)?.data?.quote ?? '';
      const rects = measureQuoteRects(contentEl, highlight.quote, sourceQuote, highlight.textStart);
      if (!rects) {
        useStore.getState().updateHighlightAnchor(id, highlight.id, null);
        continue;
      }
      const list = rects.map(rect => {
        let bx = (rect.x - contentRect.left) / zoom + scrollX - 2;
        let by = (rect.y - contentRect.top) / zoom + scrollY - 2;
        let bw = rect.w / zoom + 4;
        let bh = rect.h / zoom + 4;
        bx = Math.max(1, Math.min(bx, scrollW - 2));
        by = Math.max(1, Math.min(by, scrollH - 2));
        bw = Math.max(4, Math.min(bw, scrollW - 1 - bx));
        bh = Math.max(4, Math.min(bh, scrollH - 1 - by));
        return { x: bx, y: by, w: bw, h: bh };
      });
      boxes[highlight.id] = list;
      const last = list[list.length - 1];
      const selectionTop = Math.min(...list.map(rect => rect.y));
      const selectionBottom = Math.max(...list.map(rect => rect.y + rect.h));
      const centerY = (selectionTop + selectionBottom) / 2;
      const clampedY = Math.min(Math.max(centerY, visTop), visBottom);
      const nodeWidth = nodeRect ? nodeRect.width / zoom : null;
      useStore.getState().updateHighlightAnchor(id, highlight.id, {
        x: nodeWidth ?? offsetX + last.x + last.w - scrollX,
        y: offsetY + clampedY - scrollY,
      });
    }
    setHighlightBoxes(boxes);
  }, [id, edges, data.highlights, data.content, measureTick]);

  function handleContentMouseUp(event) {
    if (event.target.closest('.quote-popup')) return;
    const contentEl = contentRef.current;
    const selection = window.getSelection();
    if (!contentEl || !selection || selection.isCollapsed || !selection.rangeCount) {
      setQuoteButton(null);
      return;
    }
    const text = selection.toString().trim();
    const range = selection.getRangeAt(0);
    if (!text || !contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      setQuoteButton(null);
      return;
    }
    const mathElement = mathForSelection(range, contentEl);
    const contentRect = contentEl.getBoundingClientRect();
    const zoom = getViewport().zoom || 1;
    const scrollX = contentEl.scrollLeft;
    const scrollY = contentEl.scrollTop;
    const toLocal = rect => ({
      x: ((rect.x ?? rect.left) - contentRect.left) / zoom + scrollX,
      y: ((rect.y ?? rect.top) - contentRect.top) / zoom + scrollY,
      w: (rect.w ?? rect.width) / zoom,
      h: (rect.h ?? rect.height) / zoom,
    });
    const clientRects = mathElement ? mathContentRects(mathElement) : textRangeRects(range, contentEl);
    const rects = clientRects.map(toLocal);
    if (!rects.length) {
      setQuoteButton(null);
      return;
    }
    let anchor = null;
    if (nodePosition) {
      const lastClient = clientRects[clientRects.length - 1] ?? range.getBoundingClientRect();
      const right = lastClient.right ?? lastClient.x + lastClient.w;
      const selectionTop = Math.min(...clientRects.map(rect => rect.y ?? rect.top));
      const selectionBottom = Math.max(...clientRects.map(rect => (rect.y ?? rect.top) + (rect.h ?? rect.height)));
      const centerY = (selectionTop + selectionBottom) / 2;
      const point = screenToFlowPosition({ x: right, y: centerY });
      anchor = { x: point.x - nodePosition.x, y: point.y - nodePosition.y };
    }
    const first = rects[0];
    const bottom = Math.max(...rects.map(rect => rect.y + rect.h));
    const popupLeft = Math.max(12, Math.min(first.x, contentEl.scrollWidth - 380));
    const previewBoxes = rects.map(rect => ({
      x: Math.max(1, rect.x - 2),
      y: Math.max(1, rect.y - 2),
      w: rect.w + 4,
      h: rect.h + 4,
    }));
    const nodeEl = contentEl.closest('.react-flow__node');
    const nodeRectNow = nodeEl?.getBoundingClientRect();
    const offsetX = nodeRectNow ? (contentRect.left - nodeRectNow.left) / zoom : 0;
    const offsetY = nodeRectNow ? (contentRect.top - nodeRectNow.top) / zoom : 0;
    setQuoteButton({
      text,
      sourceText: selectionSourceText(range, contentEl, mathElement) || text,
      textStart: normalizedRangeStart(contentEl, range),
      anchor,
      left: offsetX + (popupLeft - scrollX),
      top: offsetY + (bottom - scrollY) + 8 / zoom,
      boxes: previewBoxes,
    });
    setInputValue('');
    setSelectionCopied(false);
    setActionsEditorOpen(false);
    selection.removeAllRanges();
  }

  function finishQuote() {
    window.getSelection()?.removeAllRanges();
    setQuoteButton(null);
    setInputValue('');
    setSelectionCopied(false);
    setActionsEditorOpen(false);
  }

  function revealNode(nodeId) {
    requestAnimationFrame(() => {
      const node = useStore.getState().nodes.find(item => item.id === nodeId);
      if (!node) return;
      const size = canvasNodeSize(node);
      const width = node.measured?.width ?? size.width;
      const height = node.measured?.height ?? size.height;
      const { x: viewX, y: viewY, zoom } = getViewport();
      const left = -viewX / zoom;
      const top = -viewY / zoom;
      const margin = 8;
      const visible = node.position.x >= left + margin
        && node.position.y >= top + margin
        && node.position.x + width <= left + window.innerWidth / zoom - margin
        && node.position.y + height <= top + window.innerHeight / zoom - margin;
      if (visible) return;
      void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom, duration: 260 });
    });
  }

  function submitInput() {
    const question = inputValue.trim();
    if (!question || !quoteButton) return;
    const questionId = askFromSelection({
      sourceId: id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
      question,
    });
    finishQuote();
    revealNode(questionId);
  }

  async function copySelection() {
    if (!quoteButton) return;
    const ok = await copyText(quoteButton.sourceText);
    if (!ok) return;
    setSelectionCopied(true);
    setTimeout(() => setSelectionCopied(false), 1800);
  }

  function runQuickAction(action) {
    if (!quoteButton) return;
    const questionId = askFromSelection({
      sourceId: id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
      question: action.label,
      prompt: buildQuickActionPrompt(action, quoteButton.sourceText),
    });
    finishQuote();
    revealNode(questionId);
  }

  function generateSelectionInteractive() {
    if (!quoteButton) return;
    void generateInteractiveFromSelection({
      sourceId: id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
    });
    finishQuote();
  }

  function branchQuestion() {
    const parent = incomingProbe ?? parentEdge;
    if (!parent) return;
    const state = useStore.getState();
    const current = state.nodes.find(node => node.id === id);
    const source = state.nodes.find(node => node.id === parent.source);
    if (!current || !source) return;
    const currentSize = canvasNodeSize(current);
    const belowTopLeft = { x: current.position.x, y: current.position.y + currentSize.height + 40 };
    if (incomingProbe) {
      const highlight = source.data.highlights?.find(item => item.id === incomingProbe.data.highlightId);
      const questionId = askFromSelection({
        sourceId: incomingProbe.source,
        quote: incomingProbe.data.quote,
        highlightQuote: highlight?.quote ?? incomingProbe.data.quote,
        textStart: highlight?.textStart ?? null,
        anchor: highlight?.anchor ?? incomingProbe.data.anchor,
        question: '',
        reuseHighlightId: highlight?.id,
        preferredPosition: belowTopLeft,
      });
      revealNode(questionId);
      return;
    }
    const questionId = useStore.getState().addNode({
      x: belowTopLeft.x + currentSize.width / 2,
      y: belowTopLeft.y + 60,
    }, source.id);
    revealNode(questionId);
  }

  function updateQuickAction(index, patch) {
    setQuickActions(actions => actions.map((action, actionIndex) =>
      actionIndex === index ? { ...action, ...patch } : action));
  }

  function removeQuickAction(index) {
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
    <>
      <div
        className={`conversation-node ${isAssistant ? 'assistant' : 'question'} ${selected ? 'selected' : ''} ${resizing ? 'is-resizing' : ''} ${isEdgeQuestion ? 'edge-question' : ''} ${questionCollapsed ? 'is-collapsed' : 'is-expanded'} ${questionClosing ? 'is-closing' : ''}`}
        onMouseEnter={scheduleQuestionExpansion}
        onMouseMove={scheduleQuestionExpansion}
        onMouseLeave={collapseQuestion}
      >
        {!checkpoint && <Handle type="target" position={Position.Left} />}
        {questionCollapsed && (
          <button
            type="button"
            className="question-collapsed-mark nodrag"
            style={{ '--question-dot-color': chain?.stroke ?? '#86a18b' }}
            aria-label="展开追问"
            title={data.content}
            onClick={() => {
              clearTimeout(questionHoverTimer.current);
              setQuestionExpanded(true);
            }}
          />
        )}
        {isAssistant ? (
          <div className="node-kind">{kindLabel}</div>
        ) : (
          <div className="node-head">
            <div className="node-kind">{kindLabel}</div>
            <span className="node-model-picker nodrag">
              <select
                className="node-model"
                aria-label="选择回答模型"
                value={selectedModelValue}
                disabled={data.pending || !providers.length}
                onChange={event => {
                  const separator = event.target.value.indexOf('::');
                  if (separator < 0) return;
                  setNodeModel(id, {
                    providerId: event.target.value.slice(0, separator),
                    modelId: event.target.value.slice(separator + 2),
                  });
                }}
              >
                {!selectedModel && <option value="">未配置模型</option>}
                {selectedModel && !selectedModelAvailable && <option value={selectedModelValue}>{selectedModel.modelId}（不可用）</option>}
                {providers.flatMap(provider => provider.modelIds.map(modelId => (
                  <option key={`${provider.id}::${modelId}`} value={`${provider.id}::${modelId}`}>{modelId}</option>
                )))}
              </select>
              <span className="node-model-caret" aria-hidden="true">
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 5 3 3 3-3" />
                </svg>
              </span>
            </span>
          </div>
        )}
        {isAssistant && <NodeResizeCorners id={id} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />}
        <NodeCard className={isAssistant ? 'assistant' : 'question'} style={chain ? { background: chain.fill, borderColor: chain.border } : undefined}>
          {isAssistant ? (
          <div className="answer-wrap">
            <div ref={contentRef} className="answer-content nodrag nowheel" onMouseUp={handleContentMouseUp}>
              {data.content ? <MarkdownContent content={data.content} fitMath /> : data.pending ? '正在生成回答…' : ''}
            {(data.highlights ?? []).map(highlight => {
              const highlightChain = highlightChainOf(highlight.id);
              return (
                <QuoteHighlight
                  key={highlight.id}
                  boxes={highlightBoxes[highlight.id]}
                  soft={highlightChain?.soft}
                />
              );
            })}
            {quoteButton && (
              <QuoteHighlight
                boxes={quoteButton.boxes}
                soft={previewChain?.soft}
              />
            )}
            {quoteButton && nodeRootEl && createPortal(
              <div
                className="quote-popup nodrag nowheel"
                style={quotePopupStyle()}
                onMouseDown={event => {
                  if (!event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
                }}
              >
                <GlassSurface className="quote-popup-row">
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
                      submitInput();
                    }}
                  />
                  <div className="quote-fixed-actions" role="group" aria-label="固定操作">
                    <button
                      type="button"
                      className="quote-action quote-interactive"
                      title="将选中内容生成互动解释"
                      onClick={generateSelectionInteractive}
                    ><DockIcon name="interactive" />生成交互</button>
                    <button
                      type="button"
                      className="quote-action"
                      onClick={copySelection}
                    >{selectionCopied ? '已复制' : '复制文本'}</button>
                  </div>
                </GlassSurface>
                <div className="quote-presets" role="group" aria-label="预设与设置">
                  {quickActions.map(action => (
                    <button
                      key={action.id}
                      type="button"
                      className="quote-action"
                      onClick={() => runQuickAction(action)}
                    >{action.label}</button>
                  ))}
                  <button
                    type="button"
                    className={`quote-gear${actionsEditorOpen ? ' is-open' : ''}`}
                    aria-label="编辑快捷按钮"
                    aria-expanded={actionsEditorOpen}
                    onClick={() => setActionsEditorOpen(value => !value)}
                  ><DockIcon name="settings" /></button>
                </div>
                {actionsEditorOpen && (
                  <GlassSurface className="quote-actions-editor">
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
                  </GlassSurface>
                )}
              </div>
            , document.body)}
            </div>
            {scrollState.visible && (
              <div className="fake-scrollbar nodrag" onMouseDown={onScrollbarMouseDown}>
                <div className="fake-thumb" style={{ top: scrollState.top, height: scrollState.height }} />
              </div>
            )}
          </div>
        ) : (
          <>
            {editing || !data.content ? (
              <textarea
                ref={questionInputRef}
                className="nodrag nowheel"
                aria-label="节点内容"
                value={data.content}
                readOnly={data.pending}
                autoFocus={editing || Boolean(data.autoFocus)}
                placeholder={data.nodeType === 'interactive' ? '输入互动要求' : '输入问题'}
                onChange={event => updateNodeContent(id, event.target.value)}
                onBlur={() => setEditing(false)}
                onKeyDown={event => {
                  if (data.pending || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  setEditing(false);
                  if (isEdgeQuestion) setQuestionDraft(false);
                  if (data.nodeType === 'interactive') void generateInteractiveFromRequest(id);
                  else void sendMessage(id);
                }}
                rows={1}
              />
            ) : (
              <div
                className={`question-content nodrag nowheel ${isEdgeQuestion && !questionDraft ? 'is-readonly' : ''}`}
                role="textbox"
                aria-label="节点内容"
                aria-readonly="true"
                tabIndex={0}
                title={isEdgeQuestion && !questionDraft ? '通过分叉新建追问' : '点击编辑'}
                onClick={() => { if (!data.pending && (!isEdgeQuestion || questionDraft)) setEditing(true); }}
                onKeyDown={event => {
                  if (data.pending || (isEdgeQuestion && !questionDraft) || (event.key !== 'Enter' && event.key !== ' ')) return;
                  event.preventDefault();
                  setEditing(true);
                }}
              >
                <MarkdownContent content={data.content} />
              </div>
            )}
            <div className="enter-hint">
              <span className="enter-hint-ghost" aria-hidden="true">{data.nodeType === 'interactive' ? 'Enter 生成交互 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行'}</span>
              <span className="enter-hint-text">{data.pending ? (data.nodeType === 'interactive' ? '正在生成交互…' : '正在等待回答…') : editing || !data.content ? (data.nodeType === 'interactive' ? 'Enter 生成交互 · Shift+Enter 换行' : 'Enter 发送 · Shift+Enter 换行') : isEdgeQuestion && !questionDraft ? '通过分叉新建追问' : '点击编辑'}</span>
            </div>
          </>
        )}
        {data.error && <div className="node-error">{data.error}</div>}
        </NodeCard>
        <div className="node-footer">
          <span className="node-time">{formatNodeTime(data.createdAt)}</span>
          {isEdgeQuestion && !questionDraft && (
            <button
              type="button"
              className="node-copy nodrag"
              title={incomingProbe ? '基于同一选区新建追问' : '基于同一来源新建追问'}
              onClick={branchQuestion}
            >分叉</button>
          )}
          {data.content?.trim() && (
            <button
              type="button"
              className="node-copy nodrag"
              onPointerDownCapture={event => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                void copyContent();
              }}
              onMouseDown={event => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                void copyContent();
              }}
              onClick={() => void copyContent()}
            >{copied ? '已复制' : copyFailed ? '复制失败' : '复制'}</button>
          )}
        </div>
        {!checkpoint && <Handle type="source" position={Position.Right} id="right" />}
        {isAssistant && !checkpoint && (
          <Handle
            type="source"
            position={Position.Left}
            id="left"
            style={{ top: '75%', opacity: 0 }}
            title="拖到空白处新建追问"
          />
        )}
      </div>
    </>
  );
}

function InteractiveNode({ id, data, selected }) {
  const regenerateInteractive = useStore(state => state.regenerateInteractive);
  const srcDoc = useMemo(() => buildInteractiveDocument(data.content), [data.content]);
  const previewDoc = useMemo(() => data.previewContent ? buildInteractiveDocument(data.previewContent) : '', [data.previewContent]);
  const frameRef = useRef(null);
  const iframeRef = useRef(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [splitRatio, setSplitRatio] = useState(DEFAULT_INTERACTIVE_SPLIT_RATIO);
  const { resizing, onResizeStart, onResizeEnd } = useNodeResizeState();

  function syncSplitRatio(width, height) {
    setSplitRatio(height * INTERACTIVE_ASPECT_RATIO / width);
  }

  function applySplitRatio(value) {
    const nextRatio = Math.min(0.75, Math.max(0.35, value));
    setSplitRatio(nextRatio);
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? node.style?.width ?? DEFAULT_INTERACTIVE_SIZE.width;
    const height = node.measured?.height ?? node.style?.height ?? DEFAULT_INTERACTIVE_SIZE.height;
    const next = interactiveNodeSize(width, nextRatio);
    if (next.width === Math.round(width) && next.height === Math.round(height)) return;
    useStore.getState().onNodesChange([{
      id,
      type: 'dimensions',
      resizing: false,
      setAttributes: true,
      dimensions: next,
    }]);
  }

  function notifyFrameResize() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'resprout:resize', ...frameSize }, '*');
  }

  useEffect(() => {
    notifyFrameResize();
  }, [frameSize, srcDoc]);

  useLayoutEffect(() => {
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? node.style?.width ?? DEFAULT_INTERACTIVE_SIZE.width;
    const height = node.measured?.height ?? node.style?.height ?? DEFAULT_INTERACTIVE_SIZE.height;
    const next = interactiveFreeSize(width, height);
    syncSplitRatio(next.width, next.height);
    if (next.width === Math.round(width) && next.height === Math.round(height)) return;
    useStore.getState().onNodesChange([{
      id,
      type: 'dimensions',
      resizing: false,
      setAttributes: true,
      dimensions: next,
    }]);
  }, [id]);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      const next = { width: Math.round(width), height: Math.round(height) };
      setFrameSize(current => current.width === next.width && current.height === next.height ? current : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data.content]);

  function startSplit(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const container = element.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const update = moveEvent => {
      if (!rect.width) return;
      applySplitRatio((moveEvent.clientX - rect.left) / rect.width);
    };
    const finish = () => {
      element.removeEventListener('pointermove', update);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', update);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
    update(event);
  }

  return (
    <>
      <div className={`conversation-node assistant interactive-node ${selected ? 'selected' : ''} ${resizing ? 'is-resizing' : ''}`}>
        <Handle type="target" position={Position.Left} />
        <div className="node-kind">交互解释</div>
        <button
          type="button"
          className="interactive-regenerate nodrag"
          disabled={data.pending}
          title="按统一交互规范重新生成"
          onClick={() => void regenerateInteractive(id)}
        >重新生成</button>
        <NodeResizeCorners id={id} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} onResize={syncSplitRatio} />
        <NodeCard className="interactive-card">
          <div className="interactive-split" style={{ '--interactive-left': `${splitRatio * 100}%` }}>
            <section className="interactive-demo" aria-label="交互演示">
              {data.pending ? (
                <div className={`interactive-status generating${data.previewContent ? ' has-preview' : ''}`} role="status">
                  {data.previewContent && <iframe
                    className="interactive-generation-preview"
                    title="静态生成预览，待运行验收"
                    srcDoc={previewDoc}
                    sandbox=""
                    aria-hidden="true"
                    tabIndex={-1}
                    referrerPolicy="no-referrer"
                  />}
                  <div className="interactive-generation-overlay">
                    <span className="interactive-spinner" aria-hidden="true" />
                    <strong>{data.reviewing ? '正在复核内容与交互逻辑…' : '正在生成交互解释…'}</strong>
                    <span>{data.reviewing ? `第 ${data.reviewAttempt || 1} / 2 轮：静态预览已生成，正在完成运行与内容验收` : '正在设计可操作的演示和即时反馈'}</span>
                  </div>
                </div>
              ) : data.error ? (
                <div className="interactive-status failed" role="alert">
                  <strong>交互内容生成失败</strong>
                  <span>{data.error}</span>
                </div>
              ) : data.fallback ? (
                <div className="interactive-status" role="status">
                  <strong>暂未生成交互</strong>
                  <span>可查看右侧来源说明后重试。</span>
                  {data.generationDiagnostic?.summary && <span className="interactive-diagnostic">原因：{data.generationDiagnostic.summary}</span>}
                </div>
              ) : data.content ? (
                <>
                  {data.generationDiagnostic?.summary && <div className="interactive-inline-diagnostic" role="status">{data.generationDiagnostic.summary}</div>}
                  <div ref={frameRef} className="interactive-frame-wrap nodrag">
                    <iframe
                      ref={iframeRef}
                      className="interactive-frame"
                      title={data.title ? `${data.title} · 交互解释` : '交互解释'}
                      srcDoc={srcDoc}
                      width={frameSize.width || undefined}
                      height={frameSize.height || undefined}
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      onLoad={notifyFrameResize}
                    />
                  </div>
                </>
              ) : (
                <div className="interactive-status"><span>暂无交互内容</span></div>
              )}
            </section>
            <div
              className="interactive-divider nodrag nowheel nopan"
              role="separator"
              aria-label="调整交互与说明面板宽度"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(splitRatio * 100)}
              tabIndex={0}
              onPointerDown={startSplit}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const offset = event.key === 'ArrowLeft' ? -0.02 : 0.02;
                applySplitRatio(splitRatio + offset);
              }}
            ><span className="interactive-divider-handle" /></div>
            <aside className="interactive-explanation nodrag nowheel">
              <div className="interactive-explanation-head">知识点说明</div>
              <div className="interactive-explanation-content nowheel">
                {data.explanation
                  ? <MarkdownContent content={data.explanation} />
                  : <span className={`interactive-explanation-empty${data.pending ? ' is-pending' : ''}`}>{data.pending ? '正在生成知识点说明…' : '暂无知识点说明'}</span>}
              </div>
            </aside>
          </div>
        </NodeCard>
        <div className="node-footer"><span className="node-time">{formatNodeTime(data.createdAt)}</span></div>
        <Handle type="source" position={Position.Right} />
      </div>
    </>
  );
}

const ARROW_LENGTH = 13;
const ARROW_WIDTH = 11;

function trimPathWithArrow(rawPath) {
  const match = rawPath.match(/M\s*(-?[\d.]+),(-?[\d.]+)\s*C\s*(-?[\d.]+),(-?[\d.]+)\s*(-?[\d.]+),(-?[\d.]+)\s*(-?[\d.]+),(-?[\d.]+)/);
  if (!match) return { path: rawPath, arrow: null };
  const [sx, sy, c1x, c1y, c2x, c2y, tx, ty] = match.slice(1).map(Number);
  const at = t => {
    const u = 1 - t;
    return [
      u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx,
      u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty,
    ];
  };
  let t = 1;
  while (t > 0.02) {
    const [bx, by] = at(t);
    if (Math.hypot(tx - bx, ty - by) >= ARROW_LENGTH) break;
    t -= 0.02;
  }
  const [ex, ey] = at(t);
  const length = Math.hypot(tx - ex, ty - ey) || 1;
  const dx = (tx - ex) / length;
  const dy = (ty - ey) / length;
  const lerp = (a, b) => a + (b - a) * t;
  const q1x = lerp(sx, c1x);
  const q1y = lerp(sy, c1y);
  const r2x = lerp(c1x, c2x);
  const r2y = lerp(c1y, c2y);
  const q2x = lerp(q1x, r2x);
  const q2y = lerp(q1y, r2y);
  const path = `M ${sx},${sy} C ${q1x},${q1y} ${q2x},${q2y} ${ex},${ey}`;
  const bx = tx - dx * ARROW_LENGTH;
  const by = ty - dy * ARROW_LENGTH;
  const px = -dy * (ARROW_WIDTH / 2);
  const py = dx * (ARROW_WIDTH / 2);
  const arrow = `M ${tx},${ty} L ${bx + px},${by + py} L ${bx - px},${by - py} Z`;
  return { path, arrow };
}

function ThinkingEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }) {
  const sourceNode = useStore(state => state.nodes.find(node => node.id === source));
  const edges = useStore(state => state.edges);
  const selfEdge = edges.find(edge => edge.id === id);
  const checkpointNode = useStore(state => data?.checkpoint ? state.nodes.find(node => node.id === selfEdge?.source) : null);
  const isProbe = (selfEdge?.data?.kind ?? data?.kind) === 'probe';
  let chain = null;
  if (isProbe) {
    chain = CHAIN_COLORS[chainColorIndex(edges, selfEdge)] ?? null;
  } else {
    const parentEdge = edges.find(edge => edge.target === (selfEdge?.source ?? source));
    if (parentEdge?.data?.kind === 'probe') chain = CHAIN_COLORS[chainColorIndex(edges, parentEdge)] ?? null;
  }
  const pathStyle = chain
    ? { stroke: chain.stroke, ...(isProbe ? { strokeDasharray: '7 5' } : {}) }
    : isProbe
      ? { stroke: '#9db8a4', strokeDasharray: '7 5' }
      : undefined;
  const liveAnchor = sourceNode?.data.highlights?.find(highlight => highlight.id === data?.highlightId)?.anchor;
  const anchor = liveAnchor ?? data?.anchor ?? null;
  const anchored = Boolean(anchor && sourceNode);
  const startX = anchored ? sourceNode.position.x + anchor.x : sourceX;
  const startY = anchored ? sourceNode.position.y + anchor.y : sourceY;
  const [rawPath, labelX, labelY] = getBezierPath({
    sourceX: startX,
    sourceY: startY,
    targetX,
    targetY,
    sourcePosition: anchored ? Position.Right : sourcePosition,
    targetPosition,
  });
  const { path, arrow } = trimPathWithArrow(rawPath);

  return (
    <>
      <BaseEdge id={id} path={path} className="canvas-edge-hit-path" />
      <ViewportPortal>
        <svg className={`canvas-edge-overlay${selected ? ' selected' : ''}`} style={{ zIndex: data?.renderLayer }} aria-hidden="true">
          <BaseEdge path={path} style={pathStyle} interactionWidth={0} />
          {arrow && <path d={arrow} className="edge-arrow" style={chain ? { fill: chain.stroke } : undefined} />}
        </svg>
      </ViewportPortal>
      {checkpointNode && (
        <EdgeLabelRenderer>
          <div
            className="edge-question-anchor"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <ConversationNode id={checkpointNode.id} data={checkpointNode.data} selected={checkpointNode.selected} checkpoint />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { conversation: ConversationNode, interactive: InteractiveNode, pdf: PDFNode, image: ImageNode };
const edgeTypes = { thinking: ThinkingEdge };

function canvasNodeSize(node) {
  const fallback = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE
    : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE : { width: 280, height: 120 };
  return {
    width: node.measured?.width ?? node.style?.width ?? fallback.width,
    height: node.measured?.height ?? node.style?.height ?? fallback.height,
  };
}

const VIEWPORT_STORAGE_PREFIX = 'resprout.canvas-viewport.v1.';

function readCanvasViewport(sessionId) {
  try {
    const value = JSON.parse(localStorage.getItem(`${VIEWPORT_STORAGE_PREFIX}${sessionId}`) ?? 'null');
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y) || !Number.isFinite(value?.zoom)) return null;
    return { x: value.x, y: value.y, zoom: Math.max(0.2, Math.min(2, value.zoom)) };
  } catch {
    return null;
  }
}

function saveCanvasViewport(sessionId, viewport) {
  try {
    localStorage.setItem(`${VIEWPORT_STORAGE_PREFIX}${sessionId}`, JSON.stringify(viewport));
  } catch {}
}

function answeredQuestionIds(nodes, edges) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  return new Set(edges
    .filter(edge => nodeById.get(edge.source)?.data.nodeType === 'question' && nodeById.get(edge.target)?.data.role === 'assistant')
    .map(edge => edge.source));
}

function visibleLayoutGraph(nodes, edges) {
  const checkpoints = answeredQuestionIds(nodes, edges);
  const incomingByTarget = new Map(edges.map(edge => [edge.target, edge]));
  return {
    nodes: nodes.filter(node => !checkpoints.has(node.id)),
    edges: edges.flatMap(edge => {
      if (checkpoints.has(edge.target)) return [];
      if (checkpoints.has(edge.source)) {
        const incoming = incomingByTarget.get(edge.source);
        return incoming ? [{
          ...edge,
          source: incoming.source,
          data: {
            ...edge.data,
            anchor: incoming.data?.anchor ?? edge.data?.anchor,
            highlightId: incoming.data?.highlightId ?? edge.data?.highlightId,
          },
        }] : [];
      }
      return [edge];
    }),
  };
}

function Canvas({ onMessage }) {
  const nodes = useStore(state => state.nodes);
  const edges = useStore(state => state.edges);
  const sessionId = useStore(state => state.session.id);
  const [initialViewport] = useState(() => readCanvasViewport(sessionId));
  const { flowNodes, flowEdges } = useMemo(() => {
    const nodeLayers = new Map();
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const incomingByTarget = new Map(edges.map(edge => [edge.target, edge]));
    const answeredQuestions = answeredQuestionIds(nodes, edges);
    const flowNodes = nodes.flatMap((node, index) => {
      if (answeredQuestions.has(node.id)) return [];
      const zIndex = 2 * (index + 1 + (node.selected ? nodes.length : 0));
      nodeLayers.set(node.id, zIndex);
      return [{ ...node, draggable: node.data.nodeType !== 'question', dragHandle: '.node-drag-edge', zIndex }];
    });
    const flowEdges = edges.flatMap(edge => {
      if (answeredQuestions.has(edge.target)) return [];
      let source = edge.source;
      let connectionData = edge.data;
      if (answeredQuestions.has(edge.source) && nodeById.get(edge.target)?.data.role === 'assistant') {
        const incoming = incomingByTarget.get(edge.source);
        if (!incoming) return [];
        source = incoming.source;
        connectionData = {
          ...edge.data,
          checkpoint: true,
          anchor: incoming.data?.anchor ?? edge.data?.anchor,
          highlightId: incoming.data?.highlightId ?? edge.data?.highlightId,
        };
      }
      const sourceLayer = nodeLayers.get(source) ?? 2;
      const targetLayer = nodeLayers.get(edge.target) ?? 2;
      const edgeLayer = Math.max(0, Math.max(sourceLayer, targetLayer) - 1);
      return [{
        ...edge,
        source,
        zIndex: edgeLayer,
        data: { ...connectionData, renderLayer: edgeLayer },
      }];
    });
    return { flowNodes, flowEdges };
  }, [nodes, edges]);
  const onNodesChange = useStore(state => state.onNodesChange);
  const onEdgesChange = useStore(state => state.onEdgesChange);
  const onConnect = useStore(state => state.onConnect);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const previousNodeIds = useRef(new Set());
  const [connectionMenu, setConnectionMenu] = useState(null);
  const canvasHostRef = useRef(null);
  const marqueeRef = useRef(null);
  const dragDepthRef = useRef(0);
  const [marquee, setMarquee] = useState(null);
  const [pdfDropActive, setPdfDropActive] = useState(false);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const blocked = target => target.closest(
      'input, textarea, select, [contenteditable="true"], .nopan, .react-flow__handle, .react-flow__resize-control, .react-flow__minimap, .react-flow__controls'
    );
    const applyMarquee = state => {
      if (Math.hypot(state.current.x - state.start.x, state.current.y - state.start.y) < 5) return;
      const topLeft = screenToFlowPosition({ x: Math.min(state.start.x, state.current.x), y: Math.min(state.start.y, state.current.y) });
      const bottomRight = screenToFlowPosition({ x: Math.max(state.start.x, state.current.x), y: Math.max(state.start.y, state.current.y) });
      const next = useStore.getState().nodes.map(node => {
        const size = canvasNodeSize(node);
        const hit = node.position.x < bottomRight.x && node.position.x + size.width > topLeft.x
          && node.position.y < bottomRight.y && node.position.y + size.height > topLeft.y;
        const selected = state.additive ? state.base.has(node.id) || hit : hit;
        return node.selected === selected ? node : { ...node, selected };
      });
      useStore.setState({ nodes: next });
    };
    const onPointerDown = event => {
      if (event.button !== 2 || blocked(event.target)) return;
      const state = {
        start: { x: event.clientX, y: event.clientY },
        current: { x: event.clientX, y: event.clientY },
        additive: event.shiftKey,
        base: new Set(useStore.getState().nodes.filter(node => node.selected).map(node => node.id)),
      };
      marqueeRef.current = state;
      setMarquee({ x1: state.start.x, y1: state.start.y, x2: state.start.x, y2: state.start.y });
    };
    const onPointerMove = event => {
      const state = marqueeRef.current;
      if (!state) return;
      if (!(event.buttons & 2)) {
        marqueeRef.current = null;
        setMarquee(null);
        return;
      }
      state.current = { x: event.clientX, y: event.clientY };
      setMarquee({ x1: state.start.x, y1: state.start.y, x2: state.current.x, y2: state.current.y });
      applyMarquee(state);
    };
    const onPointerUp = event => {
      const state = marqueeRef.current;
      if (!state) return;
      state.current = { x: event.clientX, y: event.clientY };
      marqueeRef.current = null;
      setMarquee(null);
      applyMarquee(state);
    };
    const onContextMenu = event => {
      if (event.target.closest('.react-flow__minimap, input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
    };
    host.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    host.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [screenToFlowPosition]);

  useEffect(() => {
    const initialLoad = previousNodeIds.current.size === 0;
    const initialFitAll = initialLoad && nodes.length > 1;
    const addedNodes = nodes.filter(node => !previousNodeIds.current.has(node.id));
    previousNodeIds.current = new Set(nodes.map(node => node.id));
    if (!addedNodes.length || (initialLoad && initialViewport)) return;
    const latest = addedNodes[addedNodes.length - 1];
    const focusIds = new Set([latest.id]);
    const parentEdge = edges.find(edge => edge.target === latest.id);
    if (parentEdge) {
      focusIds.add(parentEdge.source);
      const question = nodes.find(node => node.id === parentEdge.source);
      if (latest.data.role === 'assistant') {
        for (const edge of edges.filter(item => item.source === parentEdge.source)) {
          if (nodes.find(node => node.id === edge.target)?.data.role === 'assistant') focusIds.add(edge.target);
        }
      }
      if (latest.data.role === 'assistant' && question?.data.nodeType === 'question') {
        const sourceEdge = edges.find(edge => edge.target === question.id);
        if (sourceEdge) focusIds.add(sourceEdge.source);
      }
    }
    const visibleIds = new Set(flowNodes.map(node => node.id));
    const focusNodes = (initialFitAll ? nodes.map(node => ({ id: node.id })) : Array.from(focusIds, id => ({ id })))
      .filter(node => visibleIds.has(node.id));
    if (!focusNodes.length) return;
    requestAnimationFrame(() => fitView({
      nodes: focusNodes,
      padding: 0.12,
      duration: 250,
      maxZoom: 1,
    }));
  }, [nodes, edges, fitView, flowNodes, initialViewport]);

  useOnViewportChange({
    onChange: ({ zoom }) => {
      canvasHostRef.current?.style.setProperty('--node-drag-outset', `${12 / zoom}px`);
    },
  });

  useEffect(() => {
    if (!connectionMenu) return;
    const close = () => setConnectionMenu(null);
    const onPointerDown = event => {
      if (!event.target.closest('.connection-menu')) close();
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [connectionMenu]);

  async function dropPdfs(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setPdfDropActive(false);
    const files = Array.from(event.dataTransfer.files ?? []).filter(file => file.type === 'application/pdf' || /\.pdf$/i.test(file.name) || ['image/png', 'image/jpeg', 'image/webp'].includes(file.type));
    if (!files.length) {
      onMessage('请拖入 PDF、PNG、JPEG 或 WebP 文件');
      return;
    }
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    try {
      for (const [index, file] of files.entries()) {
        const point = { x: position.x + index * 40, y: position.y + index * 40 };
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) await useStore.getState().addPdf(file, point);
        else await useStore.getState().addImage(file, point);
      }
      onMessage(`已添加 ${files.length} 个文件，选择 PDF 文字或围绕图片提问`);
    } catch (error) {
      onMessage(`文件添加失败：${error.message}`);
    }
  }

  return (
    <div
      ref={canvasHostRef}
      className="canvas-host"
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setPdfDropActive(true);
      }}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setPdfDropActive(false);
      }}
      onDrop={dropPdfs}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        zIndexMode="manual"
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => setConnectionMenu(null)}
        onMoveStart={() => setConnectionMenu(null)}
        onConnectEnd={(event, connectionState) => {
          if (connectionState.isValid || connectionState.toNode || connectionState.toHandle) return;
          const sourceId = connectionState.fromNode?.id;
          if (!sourceId || connectionState.fromHandle?.type !== 'source') return;
          const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
          if (!pointer) return;
          const flowPosition = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
          setConnectionMenu({
            sourceId,
            sourceHandle: connectionState.fromHandle?.id ?? null,
            flowPosition,
            left: Math.max(8, Math.min(pointer.clientX, window.innerWidth - 200)),
            top: Math.max(8, Math.min(pointer.clientY, window.innerHeight - 62)),
          });
        }}
        panOnScroll
        zoomOnPinch
        zoomOnScroll={false}
        selectionMode={SelectionMode.Partial}
        onPaneClick={event => {
          setConnectionMenu(null);
          if (event.detail !== 2) return;
          useStore.getState().addNode(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
        }}
        zoomOnDoubleClick={false}
        defaultViewport={initialViewport ?? { x: 0, y: 0, zoom: 1 }}
        onMoveEnd={(event, viewport) => saveCanvasViewport(sessionId, viewport)}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <MiniMap position="bottom-right" pannable zoomable />
      </ReactFlow>
      {pdfDropActive && (
        <div className="pdf-drop-overlay" aria-hidden="true">
          <div><strong>松开以添加 PDF 或图片</strong><span>文件保存在本机，PDF 可选字，图片可整图提问</span></div>
        </div>
      )}
      {marquee && (
        <div
          className="marquee-selection"
          style={{
            left: Math.min(marquee.x1, marquee.x2),
            top: Math.min(marquee.y1, marquee.y2),
            width: Math.abs(marquee.x2 - marquee.x1),
            height: Math.abs(marquee.y2 - marquee.y1),
          }}
        />
      )}
      {connectionMenu && createPortal(
        <GlassSurface
          className="connection-menu"
          style={{ left: connectionMenu.left, top: connectionMenu.top }}
          role="menu"
          aria-label="选择分支类型"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addNode(connectionMenu.flowPosition, connectionMenu.sourceId, 'point', connectionMenu.sourceHandle);
              setConnectionMenu(null);
            }}
          ><DockIcon name="plus" />追问</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void useStore.getState().generateInteractive(connectionMenu.sourceId, connectionMenu.flowPosition);
              setConnectionMenu(null);
            }}
          ><DockIcon name="interactive" />生成交互</button>
        </GlassSurface>,
        document.body,
      )}
    </div>
  );
}

const DOCK_ICONS = {
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18" />
    </>
  ),
  backup: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  fit: (
    <>
      <path d="M9 3H5a2 2 0 0 0-2 2v4" />
      <path d="M15 3h4a2 2 0 0 1 2 2v4" />
      <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
      <path d="M3 15v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  nodes: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 16 9 5 9-5" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  interactive: (
    <>
      <path d="m9 9 5 12 2.5-5.5L22 13Z" />
      <path d="M12 2v3M4.2 4.2l2.1 2.1M2 12h3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4v4" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M9 16h6" />
    </>
  ),
};

function DockIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {DOCK_ICONS[name]}
    </svg>
  );
}

function nodeMenuMeta(node, contentPreview, contentDetail) {
  const interactive = node.data.role === 'interactive';
  const reference = node.data.role === 'reference';
  const kind = node.data.role === 'assistant'
    ? '回答'
    : interactive ? '交互'
      : reference ? (node.data.assetKind === 'image' ? '图片' : 'PDF')
        : node.data.nodeType === 'root' ? '根问题'
          : node.data.nodeType === 'interactive' ? '交互要求'
            : node.data.nodeType === 'question' ? '追问' : '问题';
  const detail = contentDetail || (interactive ? node.data.explanation : reference ? '' : node.data.content);
  const preview = contentPreview || (interactive
    ? node.data.title || '交互解释'
    : reference ? node.data.fileName || 'PDF 文档'
      : plainPreview(detail ?? '').slice(0, 240));
  return { kind, preview: preview || '空白节点', detail };
}

function BranchNodeDetail({ id, content, imageAssetId }) {
  const [imageUrl, setImageUrl] = useState('');
  const [imageUnavailable, setImageUnavailable] = useState(false);
  useEffect(() => {
    if (!imageAssetId) return;
    let active = true;
    let url;
    readPdfFile(imageAssetId).then(record => {
      if (!active) return;
      if (!record) {
        setImageUnavailable(true);
        return;
      }
      url = URL.createObjectURL(record.blob);
      setImageUrl(url);
    }).catch(() => {
      if (active) setImageUnavailable(true);
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [imageAssetId]);

  return (
    <div id={id} className="branch-node-detail">
      {imageUrl && <img src={imageUrl} alt="追问的图片选区" />}
      {imageUnavailable && <p>当前浏览器中找不到选区图片。</p>}
      {content && <MarkdownContent content={content} />}
    </div>
  );
}

function BranchNodeRow({ item, side = false, expanded, onExpand, onJump, onChooseMainline }) {
  const detailId = useId();
  const { node } = item;
  const meta = nodeMenuMeta(node, item.preview, item.detail);
  const isAnswer = node.data.role === 'assistant' || node.data.role === 'interactive';
  const imageAssetId = node.data.imageAssetId;
  const canExpand = Boolean(imageAssetId || meta.detail?.trim());

  return (
    <div className={side ? 'branch-side-item' : 'branch-node-row'}>
      <button type="button" className={side ? 'branch-side-node' : 'branch-node-button'} onClick={() => onJump(node.id)}>
        {side ? (
          <>
            <span>{meta.kind}</span>
            <small>{item.nodeCount} 个节点</small>
            <strong title={meta.preview}>{meta.preview}</strong>
          </>
        ) : (
          <>
            <span className={`node-menu-avatar ${isAnswer ? 'bot' : 'user'}`} aria-hidden="true"><DockIcon name={isAnswer ? 'bot' : 'user'} /></span>
            <span className="branch-node-copy"><span>{meta.kind}</span><strong title={meta.preview}>{meta.preview}</strong></span>
          </>
        )}
      </button>
      {(canExpand || side) && (
        <div className="branch-row-actions">
          {canExpand && (
            <button type="button" className="branch-read" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => onExpand(node.id)}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
          {side && <button type="button" className="branch-set-main" onClick={() => onChooseMainline(item.parentId, item.id)}>设为主线</button>}
        </div>
      )}
      {canExpand && expanded && <BranchNodeDetail key={imageAssetId} id={detailId} content={meta.detail} imageAssetId={imageAssetId} />}
    </div>
  );
}

function BranchManager({ trees, hasOverrides, onJump, onChooseMainline, onReset, onClose }) {
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [expandedId, setExpandedId] = useState(null);
  const branchCount = trees.reduce((total, tree) => total + tree.mainline.reduce((count, item) => count + item.branches.length, 0), 0);

  function toggleDetail(id) {
    setExpandedId(current => current === id ? null : id);
  }

  function toggleBranches(id) {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="branch-manager" role="dialog" aria-label="主线与侧枝管理">
      <div className="branch-manager-header">
        <div><strong>主线与侧枝</strong><span>{branchCount} 条侧枝</span></div>
        <button type="button" aria-label="关闭主线与侧枝管理" onClick={onClose}>×</button>
      </div>
      <div className="branch-manager-body">
        {trees.length ? trees.map((tree, treeIndex) => (
          <section className="branch-tree" key={tree.id}>
            {trees.length > 1 && <div className="branch-tree-label">探索线 {treeIndex + 1}</div>}
            <div className="branch-mainline-heading"><span>主线</span><span>{tree.mainline.length} 个节点</span></div>
            <ol className="branch-mainline">
              {tree.mainline.map(item => {
                const isCollapsed = collapsed.has(item.node.id);
                return (
                  <li key={item.node.id}>
                    <BranchNodeRow item={item} expanded={expandedId === item.node.id} onExpand={toggleDetail} onJump={onJump} />
                    {item.branches.length > 0 && (
                      <div className="branch-side-group">
                        <button
                          type="button"
                          className="branch-side-toggle"
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleBranches(item.node.id)}
                        >{isCollapsed ? '展开' : '收起'}侧枝<span>{item.branches.length}</span></button>
                        {!isCollapsed && (
                          <div className="branch-side-list">
                            {item.branches.map(branch => (
                              <BranchNodeRow key={branch.id} item={branch} side expanded={expandedId === branch.id} onExpand={toggleDetail} onJump={onJump} onChooseMainline={onChooseMainline} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )) : <div className="node-menu-empty">还没有节点</div>}
      </div>
      <div className="branch-manager-footer">
        <span>点击节点定位到画布</span>
        {hasOverrides && <button type="button" onClick={onReset}>恢复默认主线</button>}
      </div>
    </div>
  );
}

function tidyLayout(nodes, edges) {
  if (nodes.length < 2) return nodes;
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const linked = new Map(nodes.map(node => [node.id, []]));
  const parentOf = new Map();
  const childrenOf = new Map();
  const branchEdgeOf = new Map();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    linked.get(edge.source).push(edge.target);
    linked.get(edge.target).push(edge.source);
    if (parentOf.has(edge.target)) continue;
    parentOf.set(edge.target, edge.source);
    branchEdgeOf.set(edge.target, edge);
    if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, []);
    childrenOf.get(edge.source).push(edge.target);
  }
  for (const [sourceId, children] of childrenOf) {
    const source = nodeById.get(sourceId);
    const infoByChild = new Map(children.map(id => {
      const edge = branchEdgeOf.get(id);
      const highlight = source?.data.highlights?.find(item => item.id === edge?.data?.highlightId);
      return [id, {
        textStart: highlight?.textStart,
        anchorY: highlight?.anchor?.y ?? edge?.data?.anchor?.y,
      }];
    }));
    const useTextOrder = children.every(id => Number.isInteger(infoByChild.get(id)?.textStart));
    const positionOf = id => {
      const info = infoByChild.get(id);
      const value = useTextOrder ? info?.textStart : info?.anchorY;
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    };
    children.sort((a, b) => {
      const positionA = positionOf(a);
      const positionB = positionOf(b);
      if (positionA !== positionB) return positionA - positionB;
      return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
    });
  }
  const metrics = new Map(nodes.map(node => {
    const fallbackWidth = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.width : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE.width : 300;
    const fallbackHeight = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.height : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE.height : 140;
    return [node.id, {
      width: Math.max(120, Math.round(node.measured?.width ?? node.style?.width ?? fallbackWidth)),
      height: Math.max(60, Math.round(node.measured?.height ?? node.style?.height ?? fallbackHeight)),
    }];
  }));
  const gapX = 72;
  const gapY = 56;
  const rootGapY = 88;

  const componentOf = new Set();
  const components = [];
  for (const node of nodes) {
    if (componentOf.has(node.id)) continue;
    const ids = [];
    const stack = [node.id];
    componentOf.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      ids.push(id);
      for (const next of linked.get(id) ?? []) {
        if (componentOf.has(next)) continue;
        componentOf.add(next);
        stack.push(next);
      }
    }
    components.push(ids);
  }

  const layoutComponent = ids => {
    const componentIds = new Set(ids);
    const rootIds = ids.filter(id => !parentOf.has(id) || !componentIds.has(parentOf.get(id)));
    const subtreeOf = new Map();
    const childrenIn = id => (childrenOf.get(id) ?? []).filter(childId => componentIds.has(childId));

    const measureTree = (id, path) => {
      if (subtreeOf.has(id)) return subtreeOf.get(id);
      if (path.has(id)) return null;
      path.add(id);
      const size = metrics.get(id);
      let childrenHeight = 0;
      let count = 0;
      for (const childId of childrenIn(id)) {
        const child = measureTree(childId, path);
        if (!child) continue;
        childrenHeight += child.height + gapY;
        count += 1;
      }
      if (count) childrenHeight -= gapY;
      const subtree = { height: Math.max(size.height, childrenHeight), childrenHeight };
      subtreeOf.set(id, subtree);
      path.delete(id);
      return subtree;
    };
    for (const id of [...rootIds, ...ids]) {
      if (!subtreeOf.has(id)) measureTree(id, new Set());
    }

    const positions = new Map();
    const place = (id, top, left) => {
      if (positions.has(id) || !subtreeOf.has(id)) return;
      const size = metrics.get(id);
      const subtree = subtreeOf.get(id);
      positions.set(id, { x: left, y: top });
      const children = childrenIn(id).filter(childId => subtreeOf.has(childId) && !positions.has(childId));
      let cursor = top + Math.max(0, (subtree.height - subtree.childrenHeight) / 2);
      for (const childId of children) {
        place(childId, cursor, left + size.width + gapX);
        cursor += subtreeOf.get(childId).height + gapY;
      }
      let y = top + (subtree.height - size.height) / 2;
      if (children.length) {
        const first = children[0];
        const last = children[children.length - 1];
        const firstCenter = positions.get(first).y + metrics.get(first).height / 2;
        const lastCenter = positions.get(last).y + metrics.get(last).height / 2;
        y = (firstCenter + lastCenter - size.height) / 2;
        y = Math.max(top, Math.min(top + subtree.height - size.height, y));
      }
      positions.set(id, { x: left, y });
    };
    let rootCursor = 0;
    for (const id of [...rootIds, ...ids]) {
      if (positions.has(id)) continue;
      place(id, rootCursor, 0);
      rootCursor += (subtreeOf.get(id)?.height ?? metrics.get(id).height) + rootGapY;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [id, position] of positions) {
      const size = metrics.get(id);
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + size.width);
      maxY = Math.max(maxY, position.y + size.height);
    }
    if (!Number.isFinite(minX)) return { positions, width: 0, height: 0 };
    for (const position of positions.values()) {
      position.x -= minX;
      position.y -= minY;
    }
    return { positions, width: maxX - minX, height: maxY - minY };
  };

  const boxes = components.map(ids => layoutComponent(ids));
  const gap = 56;
  let totalArea = 0;
  let widest = 0;
  for (const box of boxes) {
    totalArea += box.width * box.height;
    widest = Math.max(widest, box.width);
  }
  const candidateWidths = new Set([widest, widest * 1.5, Number.POSITIVE_INFINITY]);
  for (const aspect of [1.6, 2, 2.4, 3]) candidateWidths.add(Math.sqrt(totalArea * aspect));
  let best = null;
  for (const rawWidth of candidateWidths) {
    const maxWidth = Math.max(widest, rawWidth);
    const ordered = [...boxes].sort((a, b) => b.width * b.height - a.width * a.height);
    const placements = [];
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    let width = 0;
    for (const box of ordered) {
      if (cursorX > 0 && cursorX + box.width > maxWidth) {
        cursorX = 0;
        cursorY += rowHeight + gap;
        rowHeight = 0;
      }
      placements.push({ box, x: cursorX, y: cursorY });
      cursorX += box.width + gap;
      rowHeight = Math.max(rowHeight, box.height);
      width = Math.max(width, cursorX - gap);
    }
    const height = cursorY + rowHeight;
    const aspect = width / Math.max(1, height);
    const score = width * height * (1 + 0.12 * Math.abs(Math.log(aspect / 2)));
    if (!best || score < best.score) best = { placements, score };
  }
  const positions = new Map();
  for (const { box, x, y } of best.placements) {
    for (const [id, position] of box.positions) {
      positions.set(id, { x: x + position.x, y: y + position.y });
    }
  }
  for (const node of nodes) {
    if (!positions.has(node.id)) positions.set(node.id, { x: 0, y: 0 });
  }
  return nodes.map(node => {
    const position = positions.get(node.id) ?? node.position;
    return {
      ...node,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    };
  });
}

function buildLiquidGlassMap(width, height) {
  const resolution = 4;
  const canvasWidth = width * resolution;
  const canvasHeight = height * resolution;
  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d');
  const image = context.createImageData(canvasWidth, canvasHeight);
  const data = image.data;
  const inset = Math.min(8 * resolution, canvasHeight / 4);
  const halfWidth = canvasWidth / 2;
  const halfHeight = canvasHeight / 2;
  const innerWidth = Math.max(1, halfWidth - inset);
  const innerHeight = Math.max(1, halfHeight - inset);
  const radius = innerHeight;
  const shift = Math.max(2, Math.round(height * 0.09)) * resolution;
  const sdf = (x, y) => {
    const qx = Math.abs(x) - innerWidth + radius;
    const qy = Math.abs(y) - innerHeight + radius;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
  };
  for (let y = 0; y < canvasHeight; y += 1) {
    for (let x = 0; x < canvasWidth; x += 1) {
      const px = x + 0.5 - halfWidth;
      const py = y + 0.5 - halfHeight;
      const distance = sdf(px, py);
      const t = Math.max(0, Math.min(1, distance / inset));
      const weight = distance > 0 ? Math.sin(Math.PI * t) : 0;
      let dx = 0;
      let dy = 0;
      if (weight > 0) {
        const gx = sdf(px + 1, py) - sdf(px - 1, py);
        const gy = sdf(px, py + 1) - sdf(px, py - 1);
        const gradientLength = Math.hypot(gx, gy) || 1;
        dx = -(gx / gradientLength) * shift * weight;
        dy = -(gy / gradientLength) * shift * weight;
      }
      const index = (y * canvasWidth + x) * 4;
      data[index] = Math.round(127.5 + (dx / (2 * shift)) * 255);
      data[index + 1] = Math.round(127.5 + (dy / (2 * shift)) * 255);
      data[index + 2] = 127;
      data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return { href: canvas.toDataURL('image/png'), scale: Math.round(height * 0.09) * 2 };
}

function useLiquidGlass(ref, enabled = true) {
  const filterId = `liquid-glass-${useId().replace(/:/g, '')}`;
  const [glass, setGlass] = useState(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = element.offsetWidth;
        const height = element.offsetHeight;
        if (width < 1 || height < 1) return;
        setGlass(current => current && current.width === width && current.height === height
          ? current
          : { width, height, ...buildLiquidGlassMap(width, height) });
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return {
    filterId,
    glass,
    style: enabled && glass
      ? {
          backdropFilter: `url(#${filterId}) blur(var(--glass-blur, 2px)) saturate(1.35)`,
          WebkitBackdropFilter: `url(#${filterId}) blur(var(--glass-blur, 2px)) saturate(1.35)`,
        }
      : undefined,
  };
}

function GlassFilterDefs({ id, glass }) {
  return (
    <svg className="liquid-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter
          id={id}
          filterUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={glass.width}
          height={glass.height}
          colorInterpolationFilters="sRGB"
        >
          <feImage
            href={glass.href}
            x="0"
            y="0"
            width={glass.width}
            height={glass.height}
            preserveAspectRatio="none"
            result="map"
          />
          <feGaussianBlur in="map" stdDeviation="1.4" result="smoothMap" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="smoothMap"
            scale={glass.scale}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />
          <feGaussianBlur in="displaced" stdDeviation="0.35" />
        </filter>
      </defs>
    </svg>
  );
}

function GlassSurface({ as: Tag = 'div', className, style, children, disabled = false, ...props }) {
  const surfaceRef = useRef(null);
  const { filterId, glass, style: glassStyle } = useLiquidGlass(surfaceRef, !disabled);
  return (
    <>
      <Tag ref={surfaceRef} className={`glass-surface${className ? ` ${className}` : ''}`} style={{ ...style, ...glassStyle }} {...props}>
        {children}
      </Tag>
      {glass && <GlassFilterDefs id={filterId} glass={glass} />}
    </>
  );
}

function Workspace({ onHome }) {
  const fileInput = useRef(null);
  const backupButton = useRef(null);
  const countButton = useRef(null);
  const [message, setMessage] = useState('画布已就绪');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backupMenu, setBackupMenu] = useState(null);
  const [nodeMenu, setNodeMenu] = useState(null);
  const [mainlineChoices, setMainlineChoices] = useState({});
  const session = useStore(state => state.session);
  const nodes = useStore(state => state.nodes);
  const edges = useStore(state => state.edges);
  const loadProviders = useStore(state => state.loadProviders);
  const webSearchEnabled = useStore(state => state.webSearchEnabled);
  const setWebSearchEnabled = useStore(state => state.setWebSearchEnabled);
  const searchConfig = useStore(state => state.searchConfig);
  const saveSearchConfig = useStore(state => state.saveSearchConfig);
  const [searchGuideOpen, setSearchGuideOpen] = useState(false);
  const [searchKeyInput, setSearchKeyInput] = useState('');
  const [searchKeySaving, setSearchKeySaving] = useState(false);
  const [searchKeyError, setSearchKeyError] = useState('');
  const { screenToFlowPosition, fitView } = useReactFlow();
  const branchTrees = useMemo(() => buildBranchTrees(nodes, edges, mainlineChoices), [nodes, edges, mainlineChoices]);
  const layoutGraph = useMemo(() => visibleLayoutGraph(nodes, edges), [nodes, edges]);

  useEffect(() => setMainlineChoices({}), [session.id]);

  useEffect(() => {
    loadProviders().catch(error => setMessage(`模型配置加载失败：${error.message}`));
  }, [loadProviders]);

  function handleWebSearchToggle() {
    if (!webSearchEnabled && !searchConfig.available) {
      setSearchKeyError('');
      setSearchGuideOpen(true);
      return;
    }
    setWebSearchEnabled(!webSearchEnabled);
  }

  async function submitSearchKey() {
    const apiKey = searchKeyInput.trim();
    if (!apiKey || searchKeySaving) return;
    setSearchKeySaving(true);
    setSearchKeyError('');
    try {
      await saveSearchConfig({ apiKey });
      setSearchGuideOpen(false);
      setSearchKeyInput('');
      setWebSearchEnabled(true);
    } catch (error) {
      setSearchKeyError(error.message);
    } finally {
      setSearchKeySaving(false);
    }
  }

  useEffect(() => {
    if (!nodes.length) return;
    const timeout = setTimeout(() => {
      try {
        saveSessionRecord(exportSession(session, nodes, edges));
      } catch (error) {
        setMessage(`自动保存失败：${error.message}`);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [session, nodes, edges]);

  useEffect(() => {
    if (!backupMenu) return;
    const onPointerDown = event => {
      if (event.target.closest('.backup-menu') || event.target.closest('.dock-backup')) return;
      setBackupMenu(null);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setBackupMenu(null);
    };
    const onResize = () => setBackupMenu(null);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [backupMenu]);

  useEffect(() => {
    if (!nodeMenu) return;
    const onPointerDown = event => {
      if (event.target.closest('.branch-manager') || event.target.closest('.dock-count')) return;
      setNodeMenu(null);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') setNodeMenu(null);
    };
    const onResize = () => setNodeMenu(null);
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
    };
  }, [nodeMenu]);

  function toggleBackupMenu() {
    if (backupMenu) {
      setBackupMenu(null);
      return;
    }
    const rect = backupButton.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 176;
    const center = rect.left + rect.width / 2;
    const left = Math.min(Math.max(12, center - width / 2), window.innerWidth - width - 12);
    setBackupMenu({
      left,
      bottom: window.innerHeight - rect.top + 10,
      arrowLeft: Math.min(Math.max(14, center - left), width - 14),
    });
  }

  function goHome() {
    const current = useStore.getState();
    if (current.nodes.length) {
      try {
        saveSessionRecord(exportSession(current.session, current.nodes, current.edges));
      } catch (error) {
        setMessage(`保存失败，尚未返回主页：${error.message}`);
        return;
      }
    }
    onHome();
  }

  function addNode() {
    const bounds = document.querySelector('.canvas-wrap').getBoundingClientRect();
    useStore.getState().addNode(screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    }), null, 'stack');
  }

  function toggleNodeMenu() {
    if (nodeMenu) {
      setNodeMenu(null);
      return;
    }
    const rect = countButton.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(380, window.innerWidth - 24);
    const center = rect.left + rect.width / 2;
    const left = Math.min(Math.max(12, center - width / 2), window.innerWidth - width - 12);
    setNodeMenu({
      left,
      bottom: window.innerHeight - rect.top + 10,
      arrowLeft: Math.min(Math.max(14, center - left), width - 14),
      width,
    });
  }

  function jumpToNode(id) {
    setNodeMenu(null);
    const node = nodes.find(item => item.id === id);
    const answer = node?.data.nodeType === 'question'
      ? edges.find(edge => edge.source === id && nodes.find(item => item.id === edge.target)?.data.role === 'assistant')
      : null;
    const targetId = answer?.target ?? id;
    if (!layoutGraph.nodes.some(item => item.id === targetId)) return;
    fitView({ nodes: [{ id: targetId }], padding: 0.5, duration: 260, maxZoom: 1.15 });
  }

  function fitCanvas() {
    fitView({ nodes: layoutGraph.nodes.map(node => ({ id: node.id })), padding: 0.12, duration: 220 });
  }

  function arrangeLayout() {
    const selected = layoutGraph.nodes.filter(node => node.selected);
    if (selected.length >= 2) {
      const ids = new Set(selected.map(node => node.id));
      const subEdges = layoutGraph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
      const tidied = tidyLayout(selected, subEdges);
      const byId = new Map(tidied.map(node => [node.id, node]));
      const minX = Math.min(...selected.map(node => node.position.x));
      const minY = Math.min(...selected.map(node => node.position.y));
      let tidyMinX = Number.POSITIVE_INFINITY;
      let tidyMinY = Number.POSITIVE_INFINITY;
      for (const node of tidied) {
        tidyMinX = Math.min(tidyMinX, node.position.x);
        tidyMinY = Math.min(tidyMinY, node.position.y);
      }
      const offsetX = minX - (Number.isFinite(tidyMinX) ? tidyMinX : 0);
      const offsetY = minY - (Number.isFinite(tidyMinY) ? tidyMinY : 0);
      useStore.setState({
        nodes: nodes.map(node => ids.has(node.id) && byId.has(node.id)
          ? { ...node, position: { x: byId.get(node.id).position.x + offsetX, y: byId.get(node.id).position.y + offsetY } }
          : node),
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fitView({ nodes: selected.map(node => ({ id: node.id })), padding: 0.15, duration: 320 });
      }));
      return;
    }
    if (layoutGraph.nodes.length < 2) {
      fitCanvas();
      return;
    }
    const tidied = tidyLayout(layoutGraph.nodes, layoutGraph.edges);
    const byId = new Map(tidied.map(node => [node.id, node]));
    useStore.setState({
      nodes: nodes.map(node => byId.has(node.id) ? { ...node, position: byId.get(node.id).position } : node),
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitView({ nodes: layoutGraph.nodes.map(node => ({ id: node.id })), padding: 0.12, duration: 320 });
    }));
  }

  function save() {
    const json = exportSession(useStore.getState().session, nodes, edges);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${useStore.getState().session.title}.resprout.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMessage(`已备份 ${nodes.length} 个节点`);
  }

  async function open(file) {
    if (!file) return;
    try {
      useStore.getState().loadSession(importSession(await file.text()));
      setMessage(`已从 ${file.name} 恢复`);
    } catch (error) {
      setMessage(`恢复失败：${error.message}`);
    } finally {
      fileInput.current.value = '';
    }
  }

  return (
    <div className="app-shell">
      <main className="canvas-wrap">
        <Canvas key={session.id} onMessage={setMessage} />
        {nodes.length === 0 && (
          <div className="empty-state">
            <span>让想法从这里生长</span>
            <p>双击创建问题，或拖入 PDF、图片后开始探索</p>
          </div>
        )}
      </main>
      <GlassSurface as="nav" className="dock" aria-label="画布工具栏">
        <button type="button" className="primary" onClick={addNode} aria-label="新建问题" title="新建问题"><DockIcon name="plus" /><span className="dock-label">新建</span></button>
        <button type="button" onClick={fitCanvas} aria-label="显示全部" title="显示全部"><DockIcon name="fit" /><span className="dock-label">全览</span></button>
        <button
          type="button"
          onClick={arrangeLayout}
          aria-label={nodes.some(node => node.selected) ? '整理选中节点' : '整理布局'}
          title={nodes.some(node => node.selected) ? '整理选中节点' : '整理布局'}
        ><DockIcon name="layout" /><span className="dock-label">整理</span></button>
        <button
          ref={countButton}
          type="button"
          className={`dock-count${nodeMenu ? ' is-open' : ''}`}
          onClick={toggleNodeMenu}
          aria-haspopup="dialog"
          aria-expanded={Boolean(nodeMenu)}
          aria-label={`主线与侧枝管理，共 ${nodes.length} 个节点`}
          title={`主线与侧枝 · ${message}`}
        >
          <DockIcon name="nodes" />
          <span className="dock-label">大纲</span>
          <span className="dock-count-badge">{nodes.length > 99 ? '99+' : nodes.length}</span>
        </button>
        <button
          type="button"
          className={webSearchEnabled ? 'is-active' : ''}
          aria-pressed={webSearchEnabled}
          aria-label="联网搜索"
          title="联网搜索：开启后模型自行判断检索互联网最新信息（由 DeepSeek 提供）"
          onClick={handleWebSearchToggle}
        >
          <DockIcon name="web" />
          <span className="dock-label">联网</span>
        </button>
        <span className="dock-separator" aria-hidden="true" />
        <button
          ref={backupButton}
          type="button"
          className={`dock-backup${backupMenu ? ' is-open' : ''}`}
          aria-label="备份/恢复"
          title="备份/恢复"
          aria-haspopup="menu"
          aria-expanded={Boolean(backupMenu)}
          onClick={toggleBackupMenu}
        ><DockIcon name="backup" /><span className="dock-label">备份</span></button>
        <button type="button" onClick={goHome} aria-label="会话主页" title="会话主页"><DockIcon name="home" /><span className="dock-label">主页</span></button>
        <button type="button" onClick={() => setSettingsOpen(true)} aria-label="模型设置" title="模型设置"><DockIcon name="settings" /><span className="dock-label">设置</span></button>
        <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event => open(event.target.files[0])} />
      </GlassSurface>
      {nodeMenu && createPortal(
        <div className="popover" style={{ left: nodeMenu.left, bottom: nodeMenu.bottom, width: nodeMenu.width }}>
          <BranchManager
            trees={branchTrees}
            hasOverrides={Object.keys(mainlineChoices).length > 0}
            onJump={jumpToNode}
            onChooseMainline={(parentId, childId) => setMainlineChoices(current => ({ ...current, [parentId]: childId }))}
            onReset={() => setMainlineChoices({})}
            onClose={() => setNodeMenu(null)}
          />
          <span className="popover-arrow" style={{ left: nodeMenu.arrowLeft }} aria-hidden="true" />
        </div>,
        document.body,
      )}
      {backupMenu && createPortal(
        <div className="popover" style={{ left: backupMenu.left, bottom: backupMenu.bottom, width: 176 }}>
          <div className="backup-menu" role="menu" aria-label="会话备份与恢复">
          <button type="button" role="menuitem" autoFocus onClick={() => { setBackupMenu(null); save(); }}>备份到 JSON</button>
          <button type="button" role="menuitem" onClick={() => { setBackupMenu(null); fileInput.current.click(); }}>从 JSON 恢复</button>
          </div>
          <span className="popover-arrow" style={{ left: backupMenu.arrowLeft }} aria-hidden="true" />
        </div>,
        document.body,
      )}
      {settingsOpen && <ProviderSettings onClose={() => setSettingsOpen(false)} />}
      {searchGuideOpen && createPortal(
        <div className="settings-overlay" onMouseDown={event => {
          if (event.target === event.currentTarget) setSearchGuideOpen(false);
        }}>
          <div className="settings-panel provider-form search-guide-panel">
            <div className="settings-titlebar"><h2>开启联网搜索</h2></div>
            <p className="search-guide-text">开启后，回答前模型会自行判断是否需要检索互联网最新信息，并整理为附带来源链接的答复。</p>
            <p className="search-guide-text">搜索服务由 DeepSeek 提供，按成功请求计费（约 ¥5 / 1000 次，失败不计费），API Key 仅保存在本机，可前往 platform.deepseek.com 获取。已配置 DeepSeek 供应商时会自动复用其 Key，无需重复填写。</p>
            <label>DeepSeek API Key
              <input
                type="password"
                value={searchKeyInput}
                placeholder="sk-..."
                autoComplete="off"
                onChange={event => setSearchKeyInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void submitSearchKey();
                }}
              />
            </label>
            {searchKeyError && <div className="node-error">{searchKeyError}</div>}
            <div className="settings-actions">
              <button type="button" className="primary-button" disabled={searchKeySaving || !searchKeyInput.trim()} onClick={() => void submitSearchKey()}>{searchKeySaving ? '验证中…' : '验证并开启'}</button>
              <button type="button" onClick={() => setSearchGuideOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('home');

  function newSession() {
    useStore.getState().loadSession({ session: createSession(), nodes: [], edges: [] });
    setPage('workspace');
  }

  function openSession(id) {
    useStore.getState().loadSession(importSession(readSessionRecord(id)));
    setPage('workspace');
  }

  if (page === 'home') return <SessionHome onNew={newSession} onOpen={openSession} />;
  return <ReactFlowProvider><Workspace onHome={() => setPage('home')} /></ReactFlowProvider>;
}
