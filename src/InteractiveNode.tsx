import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import MarkdownContent from './Markdown.tsx';
import { buildInteractiveDocument } from './interactive-runtime.ts';
import NodeResizeCorners from './NodeResizeCorners.tsx';
import NodeCard from './NodeCard.tsx';
import {
  DEFAULT_INTERACTIVE_SIZE,
  DEFAULT_INTERACTIVE_SPLIT_RATIO,
  INTERACTIVE_ASPECT_RATIO,
  interactiveFreeSize,
  interactiveNodeSize,
} from './session.ts';
import type { ConversationNode } from './session.ts';
import { formatNodeTime, styleDimension } from './node-utils.ts';
import { useNodeResizeState } from './use-node-resize-state.ts';
import { useStore } from './store.ts';

export default function InteractiveNode({ id, data, selected }: NodeProps<ConversationNode>) {
  const regenerateInteractive = useStore(state => state.regenerateInteractive);
  const srcDoc = useMemo(() => buildInteractiveDocument(data.content), [data.content]);
  const previewDoc = useMemo(() => data.previewContent ? buildInteractiveDocument(data.previewContent) : '', [data.previewContent]);
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [splitRatio, setSplitRatio] = useState(DEFAULT_INTERACTIVE_SPLIT_RATIO);
  const { resizing, onResizeStart, onResizeEnd } = useNodeResizeState();

  function syncSplitRatio(width: number, height: number) {
    setSplitRatio(height * INTERACTIVE_ASPECT_RATIO / width);
  }

  function applySplitRatio(value: number) {
    const nextRatio = Math.min(0.75, Math.max(0.35, value));
    setSplitRatio(nextRatio);
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? styleDimension(node.style?.width) ?? DEFAULT_INTERACTIVE_SIZE.width;
    const height = node.measured?.height ?? styleDimension(node.style?.height) ?? DEFAULT_INTERACTIVE_SIZE.height;
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
    const width = node.measured?.width ?? styleDimension(node.style?.width) ?? DEFAULT_INTERACTIVE_SIZE.width;
    const height = node.measured?.height ?? styleDimension(node.style?.height) ?? DEFAULT_INTERACTIVE_SIZE.height;
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
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const next = { width: Math.round(width), height: Math.round(height) };
      setFrameSize(current => current.width === next.width && current.height === next.height ? current : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data.content]);

  function startSplit(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const container = element.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const update = (moveEvent: PointerEvent) => {
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
    update(event.nativeEvent);
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
          <div className="interactive-split" style={{ '--interactive-left': `${splitRatio * 100}%` } as CSSProperties}>
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
