import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import MarkdownContent from './Markdown.tsx';
import { buildInteractiveDocument } from './interactive-runtime.ts';
import { INTERACTIVE_MESSAGE_TYPES } from './interactive-protocol.ts';
import NodeResizeCorners from './NodeResizeCorners.tsx';
import NodeCard from './NodeCard.tsx';
import {
  DEFAULT_INTERACTIVE_SIZE,
  DEFAULT_INTERACTIVE_SPLIT_RATIO,
  INTERACTIVE_ERROR_BAR_INSET,
  interactiveNodeSize,
  interactiveSplitFromSize,
} from './session.ts';
import type { ConversationNode, ConversationNodeData } from './session.ts';
import { formatNodeTime, styleDimension } from './node-utils.ts';
import { useNodeResizeState } from './use-node-resize-state.ts';
import { useStore } from './store.ts';

function failureTitle(data: ConversationNodeData): string {
  if (data.cancelled && !data.content) return '本次生成已取消';
  if (data.generationDiagnostic?.stage === 'provider') return '交互生成服务失败';
  switch (data.issueCodes?.[0]) {
    case 'runtime-error': return '脚本执行失败';
    case 'empty-content': return '页面缺少可见内容';
    case 'navigation-unload': return '页面发生非法跳转';
    case 'output-truncated': return '模型输出被截断';
    case 'output-invalid': return '模型输出格式错误';
    case 'output-oversize': return '模型输出过大';
    case 'check-unavailable': return '页面加载超时';
    default: return data.generationDiagnostic?.stage === 'check' ? '交互页面未通过运行检查' : '交互内容生成失败';
  }
}

function failureDescription(data: ConversationNodeData): string {
  if (data.cancelled && !data.content) return '可调整要求后重试。';
  if (data.generationDiagnostic?.stage === 'provider') return '模型服务暂不可用，未修改页面内容，可稍后重试。';
  if (data.issueCodes?.[0] === 'check-unavailable') return '页面未能在限定时间内完成加载检查，未修改候选内容；可重试。';
  return '可查看右侧来源说明后重试，或导出诊断获取详细信息。';
}

const GENERATION_PHASE_LABEL: Record<string, { title: string; detail: string }> = {
  generation: { title: '正在生成交互内容…', detail: '一次生成页面与知识点说明' },
  check: { title: '正在检查运行状态…', detail: '确认页面能加载、首屏有可见内容且没有脚本错误' },
  repair: { title: '正在修复…', detail: '根据确定的运行错误重新生成完整页面，完成后会再次检查' },
};

export default function InteractiveNode({ id, data, selected }: NodeProps<ConversationNode>) {
  const regenerateInteractive = useStore(state => state.regenerateInteractive);
  const cancelInteractiveGeneration = useStore(state => state.cancelInteractiveGeneration);
  const exportInteractiveDiagnostic = useStore(state => state.exportInteractiveDiagnostic);
  const srcDoc = useMemo(() => buildInteractiveDocument(data.content), [data.content]);
  const previewDoc = useMemo(() => data.previewContent ? buildInteractiveDocument(data.previewContent) : '', [data.previewContent]);
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const [splitRatio, setSplitRatio] = useState(DEFAULT_INTERACTIVE_SPLIT_RATIO);
  const [frameError, setFrameError] = useState<{ message: string } | null>(null);
  const errorBarRef = useRef<HTMLDivElement>(null);
  // 错误条占位：按实际渲染高度补偿节点高度（封顶预算内），iframe 视口保持 3:2。
  const [errorBarHeight, setErrorBarHeight] = useState(0);
  const { resizing, onResizeStart, onResizeEnd } = useNodeResizeState();
  const topInset = frameError ? Math.min(64, Math.max(INTERACTIVE_ERROR_BAR_INSET, errorBarHeight)) : 0;
  const topInsetRef = useRef(topInset);
  topInsetRef.current = topInset;
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;

  // 展示 iframe 在检查窗口之后出现的错误：只提示具体错误和重新生成入口，不自动开启修复。
  useEffect(() => {
    setFrameError(null);
  }, [data.content]);

  useLayoutEffect(() => {
    if (!frameError) {
      setErrorBarHeight(0);
      return;
    }
    const element = errorBarRef.current;
    if (!element) return;
    const measured = Math.round(element.getBoundingClientRect().height);
    setErrorBarHeight(current => (measured > 0 && Math.abs(current - measured) > 0.5 ? measured : current));
  }, [frameError]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const message = event.data as { type?: string; message?: string } | null;
      if (!message || message.type !== INTERACTIVE_MESSAGE_TYPES.displayError) return;
      setFrameError({ message: String(message.message || '页面脚本运行失败').slice(0, 300) });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  function downloadDiagnostics() {
    const exported = exportInteractiveDiagnostic(id);
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported.json], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exported.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function syncSplitRatio(width: number, height: number) {
    setSplitRatio(interactiveSplitFromSize(width, height, topInsetRef.current));
  }

  function applySplitRatio(value: number) {
    const nextRatio = Math.min(0.75, Math.max(0.35, value));
    setSplitRatio(nextRatio);
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? styleDimension(node.style?.width) ?? DEFAULT_INTERACTIVE_SIZE.width;
    const next = interactiveNodeSize(width, nextRatio, topInsetRef.current);
    if (next.width === Math.round(width) && next.height === Math.round(node.measured?.height ?? styleDimension(node.style?.height) ?? 0)) return;
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

  // 统一几何入口：初始挂载、存档恢复、错误条出现/消失时，把节点尺寸归一到
  // “iframe 视口 3:2 + 外层装饰预留”。旧的非规范存档尺寸会被温和归一化，内容与分栏偏好保留。
  // 规则：当前尺寸若已符合“用户分栏占比 + 当前状态条占位”的计划则不动；
  // 若只符合上一状态条占位的计划（错误条出现/消失），保留分栏只补高度；
  // 否则视为外部/存档尺寸，从中反推用户分栏后归一化。
  useLayoutEffect(() => {
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const width = node.measured?.width ?? styleDimension(node.style?.width) ?? DEFAULT_INTERACTIVE_SIZE.width;
    const height = node.measured?.height ?? styleDimension(node.style?.height) ?? DEFAULT_INTERACTIVE_SIZE.height;
    const inset = topInsetRef.current;
    const planned = interactiveNodeSize(width, splitRatioRef.current, inset);
    const matchesPlan = Math.abs(planned.width - width) <= 1.5 && Math.abs(planned.height - height) <= 1.5;
    let split = splitRatioRef.current;
    if (!matchesPlan) {
      const previousInsetPlan = interactiveNodeSize(width, splitRatioRef.current, 0);
      const matchesPreviousInset = Math.abs(previousInsetPlan.width - width) <= 1.5
        && Math.abs(previousInsetPlan.height - height) <= 1.5;
      if (!matchesPreviousInset) {
        split = interactiveSplitFromSize(width, height, inset);
        if (Math.abs(split - splitRatioRef.current) > 0.001) setSplitRatio(split);
      }
    }
    const next = interactiveNodeSize(width, split, inset);
    // 约 1 个 CSS 像素以内的舍入差不再回写，避免测量/回写反馈循环。
    if (Math.abs(next.width - width) <= 1.5 && Math.abs(next.height - height) <= 1.5) return;
    useStore.getState().onNodesChange([{
      id,
      type: 'dimensions',
      resizing: false,
      setAttributes: true,
      dimensions: next,
    }]);
  }, [id, topInset]);

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    let frame: number | null = null;
    let pending: { width: number; height: number } | null = null;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // 零尺寸（隐藏/未挂载）延迟绘制与通知，不回写 NaN。
      if (width < 0.5 || height < 0.5) return;
      const next = { width: Math.round(width), height: Math.round(height) };
      pending = next;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const value = pending;
        pending = null;
        if (!value) return;
        setFrameSize(current => Math.abs(current.width - value.width) < 0.5 && Math.abs(current.height - value.height) < 0.5 ? current : value);
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      pending = null;
    };
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
        {data.pending && (
          <button
            type="button"
            className="interactive-cancel nodrag"
            title="取消本次生成"
            onClick={() => cancelInteractiveGeneration(id)}
          >取消</button>
        )}
        {data.generationDiagnostic && data.generationDiagnostic.stage !== 'restored' && (
          <button
            type="button"
            className="interactive-diagnostic-export nodrag"
            title="导出诊断包（包含用户材料，不包含凭证）"
            onClick={downloadDiagnostics}
          >导出诊断</button>
        )}
        <NodeResizeCorners id={id} resizeInset={topInset} onResizeStart={onResizeStart} onResizeEnd={onResizeEnd} onResize={syncSplitRatio} />
        <NodeCard className="interactive-card">
          <div className="interactive-split" style={{ '--interactive-left': `${splitRatio * 100}%` } as CSSProperties}>
            <section className="interactive-demo" aria-label="交互演示">
              {data.pending ? (
                <div className={`interactive-status generating${data.previewContent ? ' has-preview' : ''}`} role="status">
                  {data.previewContent && <iframe
                    className="interactive-generation-preview"
                    title="静态生成预览，待运行检查"
                    srcDoc={previewDoc}
                    sandbox=""
                    aria-hidden="true"
                    tabIndex={-1}
                    referrerPolicy="no-referrer"
                  />}
                  <div className="interactive-generation-overlay">
                    <span className="interactive-spinner" aria-hidden="true" />
                    <strong>{GENERATION_PHASE_LABEL[data.phase ?? 'generation'].title}</strong>
                    <span>{GENERATION_PHASE_LABEL[data.phase ?? 'generation'].detail}</span>
                  </div>
                </div>
              ) : data.error ? (
                <div className="interactive-status failed" role="alert">
                  <strong>交互内容生成失败</strong>
                  <span>{data.error}</span>
                </div>
              ) : data.fallback ? (
                <div className={`interactive-status${data.technicalStatus === 'fail' ? ' failed' : ''}`} role="status">
                  <strong>{failureTitle(data)}</strong>
                  <span>{failureDescription(data)}</span>
                  {data.generationDiagnostic?.summary && <span className="interactive-diagnostic">原因：{data.generationDiagnostic.summary}</span>}
                </div>
              ) : data.content ? (
                <>
                  {frameError && (
                    <div ref={errorBarRef} className="interactive-frame-error" role="alert">
                      <strong>交互页面运行出错</strong>
                      <span>{frameError.message}</span>
                      <button
                        type="button"
                        className="nodrag"
                        disabled={data.pending}
                        onClick={() => void regenerateInteractive(id)}
                      >重新生成</button>
                    </div>
                  )}
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
        <div className="node-footer">
          <span className="node-time">{formatNodeTime(data.createdAt)}</span>
          {data.generationDiagnostic?.summary && (
            <span
              className="node-diagnostic-summary"
              title={data.generationDiagnostic.summary}
              role="status"
            >
              {data.generationDiagnostic.summary}
              {data.recoveryStatus === 'unverified' ? '（旧版本未重新审核）' : data.recoveryStatus === 'rejected' ? '（旧版本未通过当前检查）' : ''}
            </span>
          )}
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    </>
  );
}
