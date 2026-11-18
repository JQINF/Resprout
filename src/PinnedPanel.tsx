import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow } from '@xyflow/react';
import MarkdownContent from './Markdown.tsx';
import NodeCard from './NodeCard.tsx';
import PDFViewer from './PDFViewer.tsx';
import { NodePinButton } from './NodePin.tsx';
import { buildQuoteSelection, QuoteHighlight, QuotePopup, useQuoteHighlights } from './quote.tsx';
import type { QuoteSelection } from './quote.tsx';
import { CHAIN_COLORS, chainColorIndex } from './chain-colors.ts';
import { canCreateFollowupFrom } from './session.ts';
import { formatNodeTime } from './node-utils.ts';
import { useStore } from './store.ts';

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

// 面板右缘的输出点：把 mousedown 转发给停靠节点隐藏的 source handle，
// 让 React Flow 原生完成拖线、松手弹追问菜单的整套交互。
function startDockedOutputDrag(nodeId: string, event: ReactMouseEvent<HTMLElement>) {
  const handle = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .react-flow__handle.docked-output`,
  );
  if (!handle) return;
  handle.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    buttons: 1,
    clientX: event.clientX,
    clientY: event.clientY,
  }));
}

export default function PinnedPanel() {
  const pinnedNodeId = useStore(state => state.pinnedNodeId);
  const node = useStore(state => state.nodes.find(item => item.id === pinnedNodeId));
  const width = useStore(state => state.pinnedPanelWidth);
  const setPinnedPanelWidth = useStore(state => state.setPinnedPanelWidth);
  const unpinNode = useStore(state => state.unpinNode);
  const askFromSelection = useStore(state => state.askFromSelection);
  const generateInteractiveFromSelection = useStore(state => state.generateInteractiveFromSelection);
  const edges = useStore(state => state.edges);
  const { getViewport, screenToFlowPosition } = useReactFlow();
  const panelRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [quoteButton, setQuoteButton] = useState<QuoteSelection | null>(null);
  const [copied, setCopied] = useState(false);
  const viewportTick = useStore(state => state.pinnedDockTick);

  const isPdf = node?.data.role === 'reference';

  useEffect(() => {
    if (pinnedNodeId && !node) unpinNode();
  }, [pinnedNodeId, node, unpinNode]);

  useEffect(() => {
    if (!quoteButton) return;
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.quote-popup')) setQuoteButton(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQuoteButton(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [quoteButton]);

  const highlightBoxes = useQuoteHighlights({
    nodeId: pinnedNodeId ?? '',
    contentRef,
    highlights: node?.data.highlights,
    content: node?.data.content ?? '',
    pending: node?.data.pending ?? false,
    enabled: Boolean(pinnedNodeId) && !isPdf,
    getNodeEl: () => panelRef.current,
    viewportTick,
  });

  async function copyContent() {
    if (!node?.data.content) return;
    const ok = await copyText(node.data.content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
  }

  async function copySelection() {
    if (quoteButton) await copyText(quoteButton.sourceText);
  }

  function submitQuestion(question: string, prompt?: string | null) {
    if (!quoteButton || !node) return;
    askFromSelection({
      sourceId: node.id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
      question,
      prompt: prompt ?? null,
    });
    setQuoteButton(null);
  }

  function generateSelectionInteractive() {
    if (!quoteButton || !node) return;
    void generateInteractiveFromSelection({
      sourceId: node.id,
      quote: quoteButton.sourceText,
      highlightQuote: quoteButton.text,
      textStart: quoteButton.textStart,
      anchor: quoteButton.anchor,
    });
    setQuoteButton(null);
  }

  function handleContentMouseUp(event: ReactMouseEvent<HTMLDivElement>) {
    const contentEl = contentRef.current;
    if (!contentEl || !node) {
      setQuoteButton(null);
      return;
    }
    setQuoteButton(buildQuoteSelection({
      eventTarget: event.target,
      contentEl,
      nodePosition: node.position,
      getViewport,
      screenToFlowPosition,
    }));
  }

  function startResize(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || width === null) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: MouseEvent) => setPinnedPanelWidth(startWidth + moveEvent.clientX - startX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  if (!pinnedNodeId || !node || width === null) return null;

  const data = node.data;
  const kindLabel = isPdf
    ? 'PDF 文档'
    : `回答${data.model ? ` · ${data.model.modelId}` : ''}`;

  const highlightChainOf = (highlightId: string) => {
    const edge = edges.find(item => item.data?.highlightId === highlightId);
    return edge ? CHAIN_COLORS[chainColorIndex(edges, edge)] ?? null : null;
  };
  const previewChain = CHAIN_COLORS[
    edges.filter(edge => edge.source === node.id && edge.data?.kind === 'probe').length % CHAIN_COLORS.length
  ] ?? null;

  return (
    <aside ref={panelRef} className="pinned-panel" style={{ width }} aria-label="已固定的卡片">
      <header className="pinned-panel-head">
        <span className="node-kind">{kindLabel}</span>
        <NodePinButton pinned title="取消固定" onToggle={unpinNode} />
      </header>
      <div className="pinned-panel-body">
        {isPdf ? (
          <NodeCard className="assistant pdf-card">
            <PDFViewer id={node.id} fileName={data.fileName ?? 'PDF 文档'} fileId={data.fileId} highlights={data.highlights} anchorRef={panelRef} />
          </NodeCard>
        ) : (
          <>
            <div ref={contentRef} className="pinned-answer-scroll nodrag nowheel" onMouseUp={handleContentMouseUp}>
              {data.content ? <MarkdownContent content={data.content} fitMath /> : data.pending ? (
                <div className="thinking-placeholder" role="status" aria-live="polite">
                  <span className="thinking-status">正在生成回答…</span>
                </div>
              ) : (
                <span className="pinned-empty">暂无内容</span>
              )}
              {(data.highlights ?? []).map(highlight => (
                <QuoteHighlight
                  key={highlight.id}
                  boxes={highlightBoxes[highlight.id]}
                  soft={highlightChainOf(highlight.id)?.soft}
                />
              ))}
              {quoteButton && (
                <QuoteHighlight boxes={quoteButton.boxes} soft={previewChain?.soft} />
              )}
              {data.error && <div className="node-error">{data.error}</div>}
            </div>
            <footer className="pinned-panel-foot">
              <span className="node-time">{formatNodeTime(data.createdAt)}</span>
              {Boolean(data.content?.trim()) && (
                <button type="button" className="node-copy nodrag" onClick={() => void copyContent()}>
                  {copied ? '已复制' : '复制'}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
      {canCreateFollowupFrom(node) && (
        <div
          className="pinned-output-dot"
          title="拖出连线，针对整篇内容追问"
          onMouseDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            startDockedOutputDrag(node.id, event);
          }}
        />
      )}
      <div className="pinned-panel-resize" onMouseDown={startResize} title="拖拽调整宽度" />
      {quoteButton && createPortal(
        <QuotePopup
          key={`${quoteButton.textStart}:${quoteButton.text.length}`}
          className="pinned-quote-popup"
          style={{ left: quoteButton.screenLeft, top: quoteButton.screenTop }}
          sourceText={quoteButton.sourceText}
          onSubmit={submitQuestion}
          onGenerateInteractive={generateSelectionInteractive}
          onCopy={copySelection}
        />,
        document.body,
      )}
    </aside>
  );
}
