import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  ElementType,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
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
import type { EdgeTypes, NodeProps, NodeTypes, Viewport, XYPosition } from '@xyflow/react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import MarkdownContent from './Markdown.tsx';
import ProviderSettings from './Settings.tsx';
import SessionHome from './Home.tsx';
import MultiModelNode from './MultiModelNode.tsx';
import NodeResizeCorners from './NodeResizeCorners.tsx';
import SelectionFrame from './SelectionFrame.tsx';
import NodeCard from './NodeCard.tsx';
import ImageNode from './ImageNode.tsx';
import Select from './Select.tsx';
import PinnedPanel from './PinnedPanel.tsx';
import { NodePinButton } from './NodePin.tsx';
import { formatNodeTime, styleDimension } from './node-utils.ts';
import { tidyLayout } from './tidy-layout.ts';
import { useNodeResizeState } from './use-node-resize-state.ts';
import { useFlowGraph, visibleLayoutGraph } from './use-flow-graph.ts';
import {
  canCreateFollowupFrom,
  createSession,
  DEFAULT_ANSWER_SIZE,
  DEFAULT_INTERACTIVE_SIZE,
  DEFAULT_MULTI_INTERACTIVE_SIZE,
  DEFAULT_MULTI_MODEL_SIZE,
  NODE_VERTICAL_GAP,
  exportSessionSnapshot,
  importSession,
  multiModelGenerationKind,
} from './session.ts';
import { hasSessionRecord, readSessionRecord, saveSessionSnapshot } from './session-library.ts';
import { exportSessionBackup, importSessionBackup } from './session-backup.ts';
import { buildBranchTrees, plainPreview } from './branch-manager.ts';
import type { BranchMainlineItem, BranchSideItem, BranchTree } from './branch-manager.ts';
import { readPdfFile } from './pdf-store.ts';
import { buildQuoteSelection, quotePopupScreenStyle, QuoteHighlight, QuotePopup, useQuoteHighlights } from './quote.tsx';
import type { QuoteSelection } from './quote.tsx';
import { CHAIN_COLORS, chainColorIndex } from './chain-colors.ts';
import type { ChainColor } from './chain-colors.ts';
import { cacheCurrentSession, cachedSession, useStore } from './store.ts';
import type {
  Anchor,
  ConversationEdgeData,
  ConversationNode as ConversationFlowNode,
  ConversationNodeData,
  GenerationRunKind,
} from './session.ts';

type NodeData = ConversationNodeData;
type EdgeData = ConversationEdgeData;
type SizedNode = Pick<ConversationFlowNode, 'data' | 'measured' | 'style'>;

type ScrollState = { top: number; height: number; visible: boolean };
type MarqueeBox = { x1: number; y1: number; x2: number; y2: number };
type MarqueeState = {
  start: Anchor;
  current: Anchor;
  additive: boolean;
  base: Set<string>;
};

type ConnectionMenu = {
  sourceId: string;
  sourceHandle: string | null;
  flowPosition: XYPosition;
  left: number;
  top: number;
};

type CreateNodeMenu = {
  flowPosition: XYPosition;
  left: number;
  top: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closestElement(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

function clearTimer(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 800)),
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

type ConversationNodeProps = {
  id: string;
  data: NodeData;
  selected?: boolean;
  checkpoint?: boolean;
};

function QuoteViewportTracker({ onChange }: { onChange: () => void }) {
  useOnViewportChange({ onChange });
  return null;
}

function ConversationNode({ id, data, selected, checkpoint = false }: ConversationNodeProps) {
  const updateNodeContent = useStore(state => state.updateNodeContent);
  const sendMessage = useStore(state => state.sendMessage);
  const askFromSelection = useStore(state => state.askFromSelection);
  const generateInteractiveFromRequest = useStore(state => state.generateInteractiveFromRequest);
  const generateInteractiveFromSelection = useStore(state => state.generateInteractiveFromSelection);
  const addMultiModelFromSelection = useStore(state => state.addMultiModelFromSelection);
  const setNodeModel = useStore(state => state.setNodeModel);
  const providers = useStore(state => state.providers);
  const activeProvider = useStore(state => state.activeProvider);
  const nodePosition = useStore(state => state.nodes.find(node => node.id === id)?.position);
  const parentEdge = useStore(state => state.edges.find(edge => edge.target === id));
  const grandProbe = useStore(state => parentEdge
    ? state.edges.find(edge => edge.target === parentEdge.source && edge.data?.kind === 'probe')
    : null);
  const edges = useStore(useShallow(state => state.edges.filter(edge => edge.data?.kind === 'probe')));
  const { getViewport, setCenter, screenToFlowPosition } = useReactFlow();
  const contentRef = useRef<HTMLDivElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const [nodeRootEl, setNodeRootEl] = useState<Element | null>(null);
  const [quoteButton, setQuoteButton] = useState<QuoteSelection | null>(null);
  const [scrollState, setScrollState] = useState<ScrollState>({ top: 0, height: 0, visible: false });
  const isAssistant = data.role === 'assistant';
  const selectedModel = data.model ?? activeProvider;
  const selectedModelValue = selectedModel ? `${selectedModel.providerId}::${selectedModel.modelId}` : '';
  const selectedModelId = selectedModel?.modelId;
  const selectedModelAvailable = selectedModelId !== undefined
    && providers.some(provider => provider.id === selectedModel?.providerId && provider.modelIds.includes(selectedModelId));
  const answerModelLabel = data.model?.modelId ?? '';
  const kindLabel = isAssistant
    ? `回答${answerModelLabel ? ` · ${answerModelLabel}` : ''}`
    : data.nodeType === 'root' ? '根问题' : data.nodeType === 'interactive' ? '交互' : data.nodeType === 'question' ? '追问' : '问题';
  const incomingProbe = parentEdge?.data.kind === 'probe' ? parentEdge : null;
  const chain = isAssistant
    ? (grandProbe ? CHAIN_COLORS[chainColorIndex(edges, grandProbe)] ?? null : null)
    : (incomingProbe ? CHAIN_COLORS[chainColorIndex(edges, incomingProbe)] ?? null : null);
  const thinking = data.pending && !data.content && parentEdge?.data.streaming && Boolean(parentEdge.data.thinking.trim());
  const thinkingPreview = thinking && parentEdge ? parentEdge.data.thinking.slice(-800) : '';
  const previewChain = CHAIN_COLORS[
    edges.filter(edge => edge.source === id && edge.data?.kind === 'probe').length % CHAIN_COLORS.length
  ] ?? null;
  const highlightChainOf = (highlightId: string) => {
    const edge = edges.find(item => item.data?.highlightId === highlightId);
    return edge ? CHAIN_COLORS[chainColorIndex(edges, edge)] ?? null : null;
  };

  useEffect(() => {
    setNodeRootEl(contentRef.current?.closest('.react-flow__node') ?? null);
  }, []);

  const [, setViewportTick] = useState(0);
  const onQuoteViewportChange = useCallback(() => setViewportTick(tick => tick + 1), []);

  function quotePopupStyle(): CSSProperties {
    if (!nodeRootEl || !quoteButton) return {};
    return quotePopupScreenStyle(nodeRootEl, quoteButton, getViewport);
  }

  function updateScrollState() {
    const el = contentRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const visible = max > 1;
    const height = visible ? Math.max(24, (el.clientHeight / el.scrollHeight) * el.clientHeight) : 0;
    const top = visible ? (el.scrollTop / max) * (el.clientHeight - height) : 0;
    setScrollState(current => current.visible === visible
      && Math.abs(current.top - top) < 0.5
      && Math.abs(current.height - height) < 0.5
      ? current
      : { top, height, visible });
  }

  function onScrollbarMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    const el = contentRef.current;
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    const move = (moveEvent: MouseEvent) => {
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
    move(event.nativeEvent);
  }
  const [editing, setEditing] = useState(!data.content || Boolean(data.autoFocus));
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const isEdgeQuestion = data.nodeType === 'question';
  const [questionDraft, setQuestionDraft] = useState(() => isEdgeQuestion && !checkpoint && (!data.content || Boolean(data.autoFocus)));
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [questionClosing, setQuestionClosing] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const questionHoveredRef = useRef(false);
  const questionHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionCollapsed = checkpoint && isEdgeQuestion && !questionDraft && !questionExpanded && Boolean(data.content);
  const { resizing, onResizeStart, onResizeEnd } = useNodeResizeState();
  const pinned = useStore(state => state.pinnedNodeId === id);
  const pinNode = useStore(state => state.pinNode);
  const highlightBoxes = useQuoteHighlights({
    nodeId: id,
    contentRef,
    highlights: data.highlights,
    content: data.content,
    pending: data.pending,
    enabled: !pinned,
  });

  useEffect(() => {
    if (!editing) return;
    const input = questionInputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  useEffect(() => () => {
    clearTimer(questionHoverTimer);
    clearTimer(questionCloseTimer);
  }, []);

  function scheduleQuestionExpansion(event: ReactMouseEvent<HTMLDivElement>) {
    questionHoveredRef.current = true;
    if (!isEdgeQuestion || questionDraft) return;
    clearTimer(questionCloseTimer);
    setQuestionClosing(false);
    if (questionExpanded) return;
    clearTimer(questionHoverTimer);
    if (event.buttons) return;
    questionHoverTimer.current = setTimeout(() => setQuestionExpanded(true), 240);
  }

  function collapseQuestion() {
    questionHoveredRef.current = false;
    clearTimer(questionHoverTimer);
    if (!checkpoint || modelMenuOpen || !isEdgeQuestion || questionDraft || !questionExpanded) return;
    clearTimer(questionCloseTimer);
    setQuestionClosing(true);
    questionCloseTimer.current = setTimeout(() => {
      setQuestionExpanded(false);
      setQuestionClosing(false);
    }, 150);
  }

  useEffect(() => {
    if (!modelMenuOpen && checkpoint && !questionHoveredRef.current) collapseQuestion();
  }, [modelMenuOpen, checkpoint]);

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
    const onDocPointerDown = (event: PointerEvent) => {
      if (!closestElement(event.target, '.quote-popup')) finishQuote();
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
    const update = () => window.requestAnimationFrame(updateScrollState);
    contentEl.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(contentEl);
    return () => {
      contentEl.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [data.content, highlightBoxes]);

  function handleContentMouseUp(event: ReactMouseEvent<HTMLDivElement>) {
    if (closestElement(event.target, '.quote-popup')) return;
    const contentEl = contentRef.current;
    if (!contentEl) {
      setQuoteButton(null);
      return;
    }
    setQuoteButton(buildQuoteSelection({
      eventTarget: event.target,
      contentEl,
      nodePosition: nodePosition ?? null,
      getViewport,
      screenToFlowPosition,
    }));
  }

  function finishQuote() {
    window.getSelection()?.removeAllRanges();
    setQuoteButton(null);
  }

  function revealNode(nodeId: string) {
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

  function submitQuestion(question: string, prompt?: string | null) {
    if (!quoteButton) return;
    const questionId = askFromSelection({
      sourceId: id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
      question,
      prompt: prompt ?? null,
    });
    finishQuote();
    revealNode(questionId);
  }

  async function copySelection() {
    if (!quoteButton) return;
    await copyText(quoteButton.sourceText);
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

  function generateSelectionMulti(kind: GenerationRunKind) {
    if (!quoteButton) return;
    const multiId = addMultiModelFromSelection({
      sourceId: id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
    }, kind);
    finishQuote();
    revealNode(multiId);
  }

  function branchQuestion() {
    const parent = incomingProbe ?? parentEdge;
    if (!parent) return;
    const state = useStore.getState();
    const current = state.nodes.find(node => node.id === id);
    const source = state.nodes.find(node => node.id === parent.source);
    if (!current || !source) return;
    const currentSize = canvasNodeSize(current);
    const belowTopLeft = { x: current.position.x, y: current.position.y + currentSize.height + NODE_VERTICAL_GAP };
    if (incomingProbe) {
      const highlight = source.data.highlights?.find(item => item.id === incomingProbe.data.highlightId);
      const questionId = askFromSelection({
        sourceId: incomingProbe.source,
        quote: incomingProbe.data?.quote ?? '',
        highlightQuote: highlight?.quote ?? incomingProbe.data?.quote ?? '',
        textStart: highlight?.textStart ?? null,
        anchor: highlight?.anchor ?? incomingProbe.data?.anchor ?? null,
        question: '',
        reuseHighlightId: highlight?.id ?? null,
        preferredPosition: belowTopLeft,
      });
      revealNode(questionId);
      return;
    }
    const questionId: unknown = useStore.getState().addNode({
      x: belowTopLeft.x + currentSize.width / 2,
      y: belowTopLeft.y + 60,
    }, source.id);
    if (typeof questionId === 'string') revealNode(questionId);
  }

  if (pinned) {
    return (
      <div className={`conversation-node ${isAssistant ? 'assistant' : 'question'} is-docked`} aria-hidden="true">
        {!checkpoint && <Handle type="target" position={Position.Left} />}
        {!checkpoint && <Handle type="source" position={Position.Right} id="right" className="docked-output" />}
        {isAssistant && !checkpoint && (
          <Handle
            type="source"
            position={Position.Left}
            id="left"
            style={{ top: '75%', opacity: 0 }}
          />
        )}
      </div>
    );
  }

  return (
    <>
      {quoteButton && <QuoteViewportTracker onChange={onQuoteViewportChange} />}
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
            className={`question-collapsed-mark${checkpoint ? ' nodrag' : ''}`}
            style={{ '--question-dot-color': chain?.stroke ?? '#86a18b' } as CSSProperties}
            aria-label="展开追问"
            title={data.content}
            onClick={() => {
              clearTimer(questionHoverTimer);
              setQuestionExpanded(true);
            }}
          />
        )}
        {isAssistant ? (
          <div className="node-kind">{kindLabel}</div>
        ) : (
          <div className="node-head">
            <div className="node-kind">{kindLabel}</div>
            <span className="node-model-picker nodrag nowheel nopan">
              <Select
                variant="compact"
                ariaLabel="选择回答模型"
                placeholder="未配置模型"
                value={selectedModelValue}
                disabled={data.pending || !providers.length}
                onOpenChange={setModelMenuOpen}
                options={[
                  ...(selectedModel && !selectedModelAvailable ? [{ value: selectedModelValue, label: `${selectedModel.modelId}（不可用）` }] : []),
                  ...providers.flatMap(provider => provider.modelIds.map(modelId => ({
                    value: `${provider.id}::${modelId}`,
                    label: modelId,
                  }))),
                ]}
                onChange={value => {
                  const separator = value.indexOf('::');
                  if (separator < 0) return;
                  setNodeModel(id, {
                    providerId: value.slice(0, separator),
                    modelId: value.slice(separator + 2),
                  });
                }}
              />
            </span>
          </div>
        )}
        {isAssistant && <NodeResizeCorners id={id} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} />}
        <NodeCard
          className={isAssistant ? 'assistant' : 'question'}
          style={chain ? { background: chain.fill, borderColor: chain.border } : undefined}
          frameAction={isAssistant ? <NodePinButton pinned={false} title="固定到左侧" onToggle={() => pinNode(id)} /> : undefined}
        >
          {isAssistant ? (
          <div className="answer-wrap">
            <div ref={contentRef} className="answer-content nodrag nowheel" onMouseUp={handleContentMouseUp}>
              {data.content ? <MarkdownContent content={data.content} fitMath /> : data.pending ? (
                <div className="thinking-placeholder" role="status" aria-live="polite">
                  <span className="thinking-status">{thinking ? '正在思考…' : '正在生成回答…'}</span>
                  {thinkingPreview && <div className="thinking-preview">{thinkingPreview}</div>}
                </div>
              ) : ''}
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
              <QuotePopup
                key={`${quoteButton.textStart}:${quoteButton.text.length}`}
                style={quotePopupStyle()}
                sourceText={quoteButton.sourceText}
                onSubmit={submitQuestion}
                onGenerateInteractive={generateSelectionInteractive}
                onGenerateMulti={generateSelectionMulti}
                onCopy={copySelection}
              />,
              document.body,
            )}
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

const ARROW_LENGTH = 13;
const ARROW_WIDTH = 11;

function trimPathWithArrow(rawPath: string): { path: string; arrow: string | null } {
  const match = rawPath.match(/M\s*(-?[\d.]+),(-?[\d.]+)\s*C\s*(-?[\d.]+),(-?[\d.]+)\s*(-?[\d.]+),(-?[\d.]+)\s*(-?[\d.]+),(-?[\d.]+)/);
  if (!match) return { path: rawPath, arrow: null };
  const [sx = 0, sy = 0, c1x = 0, c1y = 0, c2x = 0, c2y = 0, tx = 0, ty = 0] = match.slice(1).map(Number);
  const at = (t: number): [number, number] => {
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
  const lerp = (a: number, b: number) => a + (b - a) * t;
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

type ThinkingEdgeProps = {
  id: string;
  source: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data?: EdgeData;
  selected?: boolean;
};

function ThinkingEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: ThinkingEdgeProps) {
  const sourceNode = useStore(state => state.nodes.find(node => node.id === source));
  const edges = useStore(state => state.edges);
  const selfEdge = edges.find(edge => edge.id === id);
  const checkpointNode = useStore(state => data?.checkpoint ? state.nodes.find(node => node.id === selfEdge?.source) : null);
  const isProbe = (selfEdge?.data?.kind ?? data?.kind) === 'probe';
  let chain: ChainColor | null = null;
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
  const startX = anchor && sourceNode ? sourceNode.position.x + anchor.x : sourceX;
  const startY = anchor && sourceNode ? sourceNode.position.y + anchor.y : sourceY;
  const [rawPath, labelX, labelY] = getBezierPath({
    sourceX: startX,
    sourceY: startY,
    targetX,
    targetY,
    sourcePosition: anchor && sourceNode ? Position.Right : sourcePosition,
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
            style={{ zIndex: data?.renderLayer, transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <ConversationNode id={checkpointNode.id} data={checkpointNode.data} selected={checkpointNode.selected} checkpoint />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const PDFNode = lazy(() => import('./PDFNode.tsx'));
const InteractiveNode = lazy(() => import('./InteractiveNode.tsx'));

function NodeLoading({ label }: { label: string }) {
  return (
    <div className="conversation-node assistant">
      <div className="node-kind">加载中</div>
      <NodeCard className="assistant"><div className="image-status">{label}</div></NodeCard>
    </div>
  );
}

function PDFNodeLoader(props: NodeProps<ConversationFlowNode>) {
  return <Suspense fallback={<NodeLoading label="正在加载 PDF…" />}><PDFNode {...props} /></Suspense>;
}

function InteractiveNodeLoader(props: NodeProps<ConversationFlowNode>) {
  return <Suspense fallback={<NodeLoading label="正在加载交互解释…" />}><InteractiveNode {...props} /></Suspense>;
}

const nodeTypes: NodeTypes = { conversation: ConversationNode, interactive: InteractiveNodeLoader, pdf: PDFNodeLoader, image: ImageNode, multi: MultiModelNode };
const edgeTypes: EdgeTypes = { thinking: ThinkingEdge };

function canvasNodeSize(node: SizedNode): { width: number; height: number } {
  const fallback = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE
    : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE
      : node.data.nodeType === 'multi' ? (multiModelGenerationKind(node.data) === 'interactive' ? DEFAULT_MULTI_INTERACTIVE_SIZE : DEFAULT_MULTI_MODEL_SIZE) : { width: 280, height: 120 };
  return {
    width: node.measured?.width ?? styleDimension(node.style?.width) ?? fallback.width,
    height: node.measured?.height ?? styleDimension(node.style?.height) ?? fallback.height,
  };
}

const VIEWPORT_STORAGE_PREFIX = 'resprout.canvas-viewport.v1.';

function readCanvasViewport(sessionId: string): Viewport | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${VIEWPORT_STORAGE_PREFIX}${sessionId}`) ?? 'null');
    if (typeof value !== 'object' || value === null
      || !('x' in value) || typeof value.x !== 'number' || !Number.isFinite(value.x)
      || !('y' in value) || typeof value.y !== 'number' || !Number.isFinite(value.y)
      || !('zoom' in value) || typeof value.zoom !== 'number' || !Number.isFinite(value.zoom)) return null;
    return { x: value.x, y: value.y, zoom: Math.max(0.2, Math.min(2, value.zoom)) };
  } catch {
    return null;
  }
}

function saveCanvasViewport(sessionId: string, viewport: Viewport): void {
  try {
    localStorage.setItem(`${VIEWPORT_STORAGE_PREFIX}${sessionId}`, JSON.stringify(viewport));
  } catch {}
}

function Canvas({ onMessage }: { onMessage: (message: string) => void }) {
  const nodes = useStore(state => state.nodes);
  const edges = useStore(state => state.edges);
  const sessionId = useStore(state => state.session.id);
  const [initialViewport] = useState(() => readCanvasViewport(sessionId));
  const { flowNodes, flowEdges } = useFlowGraph(nodes, edges);
  const nodeDragging = nodes.some(node => node.dragging);
  const onNodesChange = useStore(state => state.onNodesChange);
  const onEdgesChange = useStore(state => state.onEdgesChange);
  const onConnect = useStore(state => state.onConnect);
  const pinnedNodeId = useStore(state => state.pinnedNodeId);
  const pinnedPanelWidth = useStore(state => state.pinnedPanelWidth);
  const previousPinnedIdRef = useRef<string | null>(null);
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow();
  const applyPinnedDock = useCallback(() => {
    const state = useStore.getState();
    const id = state.pinnedNodeId;
    const panelWidth = state.pinnedPanelWidth;
    if (!id || !panelWidth) return;
    const node = state.nodes.find(item => item.id === id);
    if (!node) return;
    const zoom = getViewport().zoom || 1;
    const topLeft = screenToFlowPosition({ x: 0, y: 0 });
    useStore.setState(current => ({
      nodes: current.nodes.map(item => item.id === id ? {
        ...item,
        position: { x: topLeft.x, y: topLeft.y },
        style: { ...item.style, width: panelWidth / zoom, height: window.innerHeight / zoom },
      } : item),
      pinnedDockTick: current.pinnedDockTick + 1,
    }));
  }, [getViewport, screenToFlowPosition]);
  const previousNodeIds = useRef<Set<string>>(new Set());
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenu | null>(null);
  const [createNodeMenu, setCreateNodeMenu] = useState<CreateNodeMenu | null>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const dragDepthRef = useRef(0);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [panning, setPanning] = useState(false);
  const [selectionGesture, setSelectionGesture] = useState(false);
  const [pdfDropActive, setPdfDropActive] = useState(false);
  const pointerGestureActive = nodeDragging || panning || selectionGesture || Boolean(marquee);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const blocked = (target: EventTarget | null) => closestElement(target,
      'input, textarea, select, [contenteditable="true"], .nopan, .selection-frame, .react-flow__handle, .react-flow__resize-control, .react-flow__minimap, .react-flow__controls',
    );
    const applyMarquee = (state: MarqueeState) => {
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
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2 || blocked(event.target)) return;
      const state: MarqueeState = {
        start: { x: event.clientX, y: event.clientY },
        current: { x: event.clientX, y: event.clientY },
        additive: event.shiftKey,
        base: new Set(useStore.getState().nodes.filter(node => node.selected).map(node => node.id)),
      };
      marqueeRef.current = state;
      setMarquee({ x1: state.start.x, y1: state.start.y, x2: state.start.x, y2: state.start.y });
    };
    const onPointerMove = (event: PointerEvent) => {
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
    const onPointerUp = (event: PointerEvent) => {
      const state = marqueeRef.current;
      if (!state) return;
      state.current = { x: event.clientX, y: event.clientY };
      marqueeRef.current = null;
      setMarquee(null);
      applyMarquee(state);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (closestElement(event.target, '.react-flow__minimap, input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
    };
    const cancelMarquee = () => {
      marqueeRef.current = null;
      setMarquee(null);
    };
    host.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', cancelMarquee);
    host.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', cancelMarquee);
      host.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [screenToFlowPosition]);

  useEffect(() => {
    const cancelPanning = () => setPanning(false);
    window.addEventListener('pointercancel', cancelPanning);
    window.addEventListener('blur', cancelPanning);
    return () => {
      window.removeEventListener('pointercancel', cancelPanning);
      window.removeEventListener('blur', cancelPanning);
    };
  }, []);

  const nodeIdsKey = nodes.map(node => node.id).join('|');
  useEffect(() => {
    const currentNodes = useStore.getState().nodes;
    const currentEdges = useStore.getState().edges;
    const initialLoad = previousNodeIds.current.size === 0;
    const initialFitAll = initialLoad && currentNodes.length > 1;
    const addedNodes = currentNodes.filter(node => !previousNodeIds.current.has(node.id));
    previousNodeIds.current = new Set(currentNodes.map(node => node.id));
    if (!addedNodes.length || (initialLoad && initialViewport)) return;
    const latest = addedNodes[addedNodes.length - 1];
    if (!latest) return;
    const focusIds = new Set([latest.id]);
    const parentEdge = currentEdges.find(edge => edge.target === latest.id);
    if (parentEdge) {
      focusIds.add(parentEdge.source);
      const question = currentNodes.find(node => node.id === parentEdge.source);
      if (latest.data.role === 'assistant') {
        for (const edge of currentEdges.filter(item => item.source === parentEdge.source)) {
          if (currentNodes.find(node => node.id === edge.target)?.data.role === 'assistant') focusIds.add(edge.target);
        }
      }
      if (latest.data.role === 'assistant' && question?.data.nodeType === 'question') {
        const sourceEdge = currentEdges.find(edge => edge.target === question.id);
        if (sourceEdge) focusIds.add(sourceEdge.source);
      }
    }
    const visibleIds = new Set(visibleLayoutGraph(currentNodes, currentEdges).nodes.map(node => node.id));
    const focusNodes = (initialFitAll ? currentNodes.map(node => ({ id: node.id })) : Array.from(focusIds, id => ({ id })))
      .filter(node => visibleIds.has(node.id));
    if (!focusNodes.length) return;
    requestAnimationFrame(() => fitView({
      nodes: focusNodes,
      padding: 0.12,
      duration: 250,
      maxZoom: 1,
    }));
  }, [nodeIdsKey, fitView, initialViewport]);

  useOnViewportChange({
    onChange: ({ zoom }) => {
      canvasHostRef.current?.style.setProperty('--node-drag-outset', `${12 / zoom}px`);
      if (useStore.getState().pinnedNodeId) applyPinnedDock();
    },
  });

  // 滚动平移等场景 onChange 不一定每帧触发：固定期间用 rAF 兜底，视口一变立即重停靠。
  useEffect(() => {
    if (!pinnedNodeId) return;
    let raf = 0;
    let lastKey = '';
    const loop = () => {
      const viewport = getViewport();
      const key = `${viewport.x},${viewport.y},${viewport.zoom}`;
      if (key !== lastKey) {
        lastKey = key;
        applyPinnedDock();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pinnedNodeId, getViewport, applyPinnedDock]);

  useEffect(() => {
    const state = useStore.getState();
    const prevId = previousPinnedIdRef.current;
    if (prevId && prevId !== state.pinnedNodeId) {
      const restore = state.pinnedRestore;
      if (restore) {
        // 固定期间只有子树可见，子树节点可能被拖动或整理过，视口也可能被平移：按固定前的快照整体还原。
        const savedById = new Map(restore.nodes.map(item => [item.id, item]));
        useStore.setState(current => ({
          nodes: current.nodes.map(node => {
            const saved = savedById.get(node.id);
            if (!saved) return node;
            return {
              ...node,
              position: { x: saved.x, y: saved.y },
              style: { ...node.style, width: saved.width, height: saved.height },
            };
          }),
          pinnedRestore: null,
        }));
        setViewport(restore.viewport, { duration: 0 });
      }
    }
    previousPinnedIdRef.current = state.pinnedNodeId;
    if (!state.pinnedNodeId) return;
    const node = state.nodes.find(item => item.id === state.pinnedNodeId);
    if (!node) return;
    if (!useStore.getState().pinnedRestore) {
      useStore.setState({
        pinnedRestore: {
          nodes: state.nodes.map(item => {
            const size = canvasNodeSize(item);
            return { id: item.id, x: item.position.x, y: item.position.y, width: size.width, height: size.height };
          }),
          viewport: getViewport(),
        },
      });
    }
    applyPinnedDock();
  }, [pinnedNodeId, applyPinnedDock, getViewport, setViewport]);

  useEffect(() => {
    applyPinnedDock();
  }, [pinnedPanelWidth, applyPinnedDock]);

  useEffect(() => {
    const onResize = () => applyPinnedDock();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyPinnedDock]);

  useEffect(() => {
    if (!connectionMenu && !createNodeMenu) return;
    const close = () => {
      setConnectionMenu(null);
      setCreateNodeMenu(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!closestElement(event.target, '.connection-menu')) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [connectionMenu, createNodeMenu]);

  async function dropPdfs(event: ReactDragEvent<HTMLDivElement>) {
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
      onMessage(`文件添加失败：${errorMessage(error)}`);
    }
  }

  return (
    <div
      ref={canvasHostRef}
      className={`canvas-host${pointerGestureActive ? ' is-pointer-gesture' : ''}`}
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
        onlyRenderVisibleElements={flowNodes.length > 30}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => {
          setConnectionMenu(null);
          setCreateNodeMenu(null);
        }}
        onMoveStart={() => {
          setPanning(true);
          setConnectionMenu(null);
          setCreateNodeMenu(null);
        }}
        onConnectEnd={(event, connectionState) => {
          if (connectionState.isValid || connectionState.toNode || connectionState.toHandle) return;
          const sourceId = connectionState.fromNode?.id;
          if (!sourceId || connectionState.fromHandle?.type !== 'source') return;
          const sourceNode = useStore.getState().nodes.find(node => node.id === sourceId);
          if (!sourceNode) return;
          if (!canCreateFollowupFrom(sourceNode)) {
            onMessage('请先完善上游内容，再创建追问或交互');
            return;
          }
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
          if (event.detail !== 2) {
            setCreateNodeMenu(null);
            return;
          }
          setCreateNodeMenu({
            flowPosition: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            left: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
            top: Math.max(8, Math.min(event.clientY, window.innerHeight - 62)),
          });
        }}
        zoomOnDoubleClick={false}
        defaultViewport={initialViewport ?? { x: 0, y: 0, zoom: 1 }}
        onMoveEnd={(_event, viewport) => {
          setPanning(false);
          saveCanvasViewport(sessionId, viewport);
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <MiniMap position="bottom-right" pannable zoomable />
        <SelectionFrame nodes={flowNodes} getSize={canvasNodeSize} onGestureChange={setSelectionGesture} />
      </ReactFlow>
      <PinnedPanel />
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
      {createNodeMenu && createPortal(
        <Surface
          className="connection-menu create-node-menu"
          style={{ left: createNodeMenu.left, top: createNodeMenu.top }}
          role="menu"
          aria-label="选择新建节点类型"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addNode(createNodeMenu.flowPosition);
              setCreateNodeMenu(null);
            }}
          ><DockIcon name="plus" />新问题</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addMultiModelNode(createNodeMenu.flowPosition, null, null, 'answer');
              setCreateNodeMenu(null);
            }}
          ><DockIcon name="nodes" />多模型回答</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addMultiModelNode(createNodeMenu.flowPosition, null, null, 'interactive');
              setCreateNodeMenu(null);
            }}
          ><DockIcon name="nodes" />多模型交互</button>
        </Surface>,
        document.body,
      )}
      {connectionMenu && createPortal(
        <Surface
          className="connection-menu"
          style={{ left: connectionMenu.left, top: connectionMenu.top }}
          role="menu"
          aria-label="选择分支类型"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addNode(connectionMenu.flowPosition, connectionMenu.sourceId, connectionMenu.sourceHandle);
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addMultiModelNode(connectionMenu.flowPosition, connectionMenu.sourceId, connectionMenu.sourceHandle, 'answer');
              setConnectionMenu(null);
            }}
          ><DockIcon name="nodes" />多模型回答</button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              useStore.getState().addMultiModelNode(connectionMenu.flowPosition, connectionMenu.sourceId, connectionMenu.sourceHandle, 'interactive');
              setConnectionMenu(null);
            }}
          ><DockIcon name="nodes" />多模型交互</button>
        </Surface>,
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
} satisfies Record<string, ReactNode>;

type DockIconName = keyof typeof DOCK_ICONS;

function DockIcon({ name }: { name: DockIconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {DOCK_ICONS[name]}
    </svg>
  );
}

function nodeMenuMeta(
  node: { data: NodeData },
  contentPreview?: string,
  contentDetail?: string | null,
): { kind: string; preview: string; detail: string | null | undefined } {
  const interactive = node.data.role === 'interactive';
  const reference = node.data.role === 'reference';
  const kind = node.data.role === 'assistant'
    ? '回答'
    : interactive ? '交互'
      : reference ? (node.data.assetKind === 'image' ? '图片' : 'PDF')
        : node.data.nodeType === 'root' ? '根问题'
          : node.data.nodeType === 'interactive' ? '交互要求'
            : node.data.nodeType === 'multi' ? (multiModelGenerationKind(node.data) === 'interactive' ? '多模型交互' : '多模型回答')
              : node.data.nodeType === 'question' ? '追问' : '问题';
  const detail = contentDetail || (interactive ? node.data.explanation : reference ? '' : node.data.content);
  const preview = contentPreview || (interactive
    ? node.data.title || '交互解释'
    : reference ? node.data.fileName || 'PDF 文档'
      : plainPreview(detail ?? '').slice(0, 240));
  return { kind, preview: preview || '空白节点', detail };
}

function BranchNodeDetail({ id, content, imageAssetId }: { id: string; content?: string | null; imageAssetId?: string | null }) {
  const [imageUrl, setImageUrl] = useState('');
  const [imageUnavailable, setImageUnavailable] = useState(false);
  useEffect(() => {
    if (!imageAssetId) return;
    let active = true;
    let url: string | undefined;
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

type BranchItem = BranchMainlineItem | BranchSideItem;

function isBranchLeaf(item: BranchItem): item is BranchSideItem {
  return 'parentId' in item;
}

type BranchNodeRowProps = {
  item: BranchItem;
  side?: boolean;
  expanded: boolean;
  onExpand: (id: string) => void;
  onJump: (id: string) => void;
  onChooseMainline?: (parentId: string, childId: string) => void;
};

function BranchNodeRow({ item, side = false, expanded, onExpand, onJump, onChooseMainline }: BranchNodeRowProps) {
  const detailId = useId();
  const { node } = item;
  const meta = nodeMenuMeta(node, item.preview, item.detail);
  const isAnswer = node.data.role === 'assistant' || node.data.role === 'interactive';
  const imageAssetId = node.data.imageAssetId;
  const canExpand = Boolean(imageAssetId || meta.detail?.trim());
  const leaf = isBranchLeaf(item) ? item : null;

  return (
    <div className={side ? 'branch-side-item' : 'branch-node-row'}>
      <button type="button" className={side ? 'branch-side-node' : 'branch-node-button'} onClick={() => onJump(node.id)}>
        {side ? (
          <>
            <span>{meta.kind}</span>
            <small>{leaf ? leaf.nodeCount : 0} 个节点</small>
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
          {side && leaf && onChooseMainline && (
            <button type="button" className="branch-set-main" onClick={() => onChooseMainline(leaf.parentId, leaf.id)}>设为主线</button>
          )}
        </div>
      )}
      {canExpand && expanded && <BranchNodeDetail key={imageAssetId} id={detailId} content={meta.detail} imageAssetId={imageAssetId} />}
    </div>
  );
}

type BranchManagerProps = {
  trees: BranchTree[];
  hasOverrides: boolean;
  onJump: (id: string) => void;
  onChooseMainline: (parentId: string, childId: string) => void;
  onReset: () => void;
  onClose: () => void;
};

function BranchManager({ trees, hasOverrides, onJump, onChooseMainline, onReset, onClose }: BranchManagerProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const branchCount = trees.reduce((total, tree) => total + tree.mainline.reduce((count, item) => count + item.branches.length, 0), 0);

  function toggleDetail(id: string) {
    setExpandedId(current => current === id ? null : id);
  }

  function toggleBranches(id: string) {
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

type SurfaceProps = {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'children'>;

function Surface({ as: Tag = 'div', className, style, children, ...props }: SurfaceProps) {
  return (
    <Tag className={`surface${className ? ` ${className}` : ''}`} style={style} {...props}>
      {children}
    </Tag>
  );
}

type BackupMenu = { left: number; bottom: number; arrowLeft: number };
type NodeMenu = BackupMenu & { width: number };

function Workspace({ onHome }: { onHome: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const backupButton = useRef<HTMLButtonElement>(null);
  const countButton = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState('画布已就绪');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backupMenu, setBackupMenu] = useState<BackupMenu | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeMenu | null>(null);
  const [mainlineChoices, setMainlineChoices] = useState<Record<string, string>>({});
  const session = useStore(state => state.session);
  const nodes = useStore(state => state.nodes);
  const edges = useStore(state => state.edges);
  const pinnedNodeId = useStore(state => state.pinnedNodeId);
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
  const branchTrees = useMemo(() => nodeMenu ? buildBranchTrees(nodes, edges, mainlineChoices) : [], [nodeMenu, nodes, edges, mainlineChoices]);

  useEffect(() => setMainlineChoices({}), [session.id]);

  useEffect(() => {
    loadProviders().catch((error: unknown) => setMessage(`模型配置加载失败：${errorMessage(error)}`));
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
      setSearchKeyError(errorMessage(error));
    } finally {
      setSearchKeySaving(false);
    }
  }

  const persistSession = useCallback(async () => {
    const current = useStore.getState();
    let nodes = current.nodes;
    if (current.pinnedNodeId && current.pinnedRestore) {
      const saved = current.pinnedRestore.nodes.find(item => item.id === current.pinnedNodeId);
      if (saved) {
        const pinnedNodeId = current.pinnedNodeId;
        nodes = nodes.map(node => node.id === pinnedNodeId ? {
          ...node,
          position: { x: saved.x, y: saved.y },
          style: { ...node.style, width: saved.width, height: saved.height },
          measured: { width: saved.width, height: saved.height },
        } : node);
      }
    }
    if (!nodes.length && !await hasSessionRecord(current.session.id)) return;
    await saveSessionSnapshot(exportSessionSnapshot(current.session, nodes, current.edges));
  }, []);
  const saveWasBlocked = useRef(false);

  useEffect(() => {
    const blocked = nodes.some(node => node.dragging || node.data.pending);
    const wasBlocked = saveWasBlocked.current;
    saveWasBlocked.current = blocked;
    if (blocked) return;
    const timeout = setTimeout(() => {
      void persistSession().catch(error => {
        setMessage(`自动保存失败：${errorMessage(error)}`);
      });
    }, wasBlocked ? 0 : 800);
    return () => clearTimeout(timeout);
  }, [session, nodes, edges, persistSession]);

  useEffect(() => {
    const flush = () => {
      void persistSession().catch(() => {});
    };
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  }, [persistSession]);

  useEffect(() => {
    if (!backupMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (closestElement(event.target, '.backup-menu') || closestElement(event.target, '.dock-backup')) return;
      setBackupMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
    const onPointerDown = (event: MouseEvent) => {
      if (closestElement(event.target, '.branch-manager') || closestElement(event.target, '.dock-count')) return;
      setNodeMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
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

  async function goHome() {
    try {
      await persistSession();
    } catch (error) {
      setMessage(`保存失败，尚未返回主页：${errorMessage(error)}`);
      return;
    }
    onHome();
  }

  function addNode() {
    const canvas = document.querySelector<HTMLElement>('.canvas-wrap');
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    // 视口中心就近放置：按实际尺寸推开重叠节点，避免跳到全图底部。
    useStore.getState().addNode(screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    }));
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

  function jumpToNode(id: string) {
    setNodeMenu(null);
    const node = nodes.find(item => item.id === id);
    const answer = node?.data.nodeType === 'question'
      ? edges.find(edge => edge.source === id && nodes.find(item => item.id === edge.target)?.data.role === 'assistant')
      : null;
    const targetId = answer?.target ?? id;
    if (!visibleLayoutGraph(nodes, edges, pinnedNodeId).nodes.some(item => item.id === targetId)) return;
    fitView({ nodes: [{ id: targetId }], padding: 0.5, duration: 260, maxZoom: 1.15 });
  }

  function fitCanvas() {
    const layoutNodes = visibleLayoutGraph(nodes, edges, pinnedNodeId).nodes;
    const targetNodes = pinnedNodeId ? layoutNodes.filter(node => node.id !== pinnedNodeId) : layoutNodes;
    if (!targetNodes.length) return;
    fitView({ nodes: targetNodes.map(node => ({ id: node.id })), padding: 0.12, duration: 220 });
  }

  function arrangeLayout() {
    const layoutGraph = visibleLayoutGraph(nodes, edges, pinnedNodeId);
    const graphNodes = pinnedNodeId ? layoutGraph.nodes.filter(node => node.id !== pinnedNodeId) : layoutGraph.nodes;
    const graphEdges = pinnedNodeId ? layoutGraph.edges.filter(edge => edge.source !== pinnedNodeId && edge.target !== pinnedNodeId) : layoutGraph.edges;
    const selected = graphNodes.filter(node => node.selected);
    if (selected.length >= 2) {
      const ids = new Set(selected.map(node => node.id));
      const subEdges = graphEdges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
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
        nodes: nodes.map(node => {
          const tidiedNode = byId.get(node.id);
          return ids.has(node.id) && tidiedNode
            ? { ...node, position: { x: tidiedNode.position.x + offsetX, y: tidiedNode.position.y + offsetY } }
            : node;
        }),
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        fitView({ nodes: selected.map(node => ({ id: node.id })), padding: 0.15, duration: 320 });
      }));
      return;
    }
    if (graphNodes.length < 2) {
      fitCanvas();
      return;
    }
    const tidied = tidyLayout(graphNodes, graphEdges);
    const byId = new Map(tidied.map(node => [node.id, node]));
    useStore.setState({
      nodes: nodes.map(node => {
        const tidiedNode = byId.get(node.id);
        return tidiedNode ? { ...node, position: tidiedNode.position } : node;
      }),
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fitView({ nodes: graphNodes.map(node => ({ id: node.id })), padding: 0.12, duration: 320 });
    }));
  }

  async function save() {
    try {
      const json = await exportSessionBackup(useStore.getState().session, nodes, edges);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${useStore.getState().session.title}.resprout.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage(`已备份 ${nodes.length} 个节点及其附件`);
    } catch (error) {
      setMessage(`备份失败：${errorMessage(error)}`);
    }
  }

  async function open(file: File | undefined) {
    if (!file) return;
    try {
      const restored = await importSessionBackup(await file.text());
      cacheCurrentSession();
      useStore.getState().loadSession(restored.snapshot);
      setMessage(restored.missingAssets.length
        ? `已从 ${file.name} 恢复；缺少附件：${restored.missingAssets.join('、')}，请在资料卡片上重新关联`
        : `已从 ${file.name} 恢复，附件已恢复`);
    } catch (error) {
      setMessage(`恢复失败：${errorMessage(error)}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  return (
    <div className="app-shell">
      <main className="canvas-wrap">
        <Canvas key={session.id} onMessage={setMessage} />
        {nodes.length === 0 && (
          <div className="empty-state">
            <span>让想法从这里生长</span>
            <p>双击选择新问题、多模型回答或多模型交互，也可拖入 PDF、图片后开始探索</p>
          </div>
        )}
      </main>
      <Surface as="nav" className="dock" aria-label="画布工具栏">
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
        <button type="button" onClick={() => void goHome()} aria-label="会话主页" title="会话主页"><DockIcon name="home" /><span className="dock-label">主页</span></button>
        <button type="button" onClick={() => setSettingsOpen(true)} aria-label="模型设置" title="模型设置"><DockIcon name="settings" /><span className="dock-label">设置</span></button>
        <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event => {
          const file = event.target.files?.[0];
          if (file) void open(file);
        }} />
      </Surface>
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
          <button type="button" role="menuitem" autoFocus onClick={() => { setBackupMenu(null); void save(); }}>备份到 JSON</button>
          <button type="button" role="menuitem" onClick={() => { setBackupMenu(null); fileInput.current?.click(); }}>从 JSON 恢复</button>
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
  const [page, setPage] = useState<'home' | 'workspace'>('home');

  function newSession() {
    cacheCurrentSession();
    useStore.getState().loadSession({ session: createSession(), nodes: [], edges: [] });
    setPage('workspace');
  }

  async function openSession(id: string) {
    cacheCurrentSession();
    const snapshot = cachedSession(id) ?? importSession(await readSessionRecord(id));
    useStore.getState().loadSession(snapshot);
    setPage('workspace');
  }

  if (page === 'home') return <SessionHome onNew={newSession} onOpen={openSession} />;
  return <ReactFlowProvider><Workspace onHome={() => setPage('home')} /></ReactFlowProvider>;
}
