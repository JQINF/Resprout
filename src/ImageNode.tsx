import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { Handle, Position, useOnViewportChange, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import NodeCard from './NodeCard.tsx';
import NodeResizeCorners from './NodeResizeCorners.tsx';
import { readPdfFile, savePdfFile } from './pdf-store.ts';
import type { StoredPdfFile } from './pdf-store.ts';
import { buildQuickActionPrompt } from './quick-actions.ts';
import type { QuickAction } from './quick-actions.ts';
import type { Anchor, ConversationNode, ModelInput, PdfBox } from './session.ts';
import { useStore } from './store.ts';
import type { ProviderInfo } from './store.ts';
import './ImageNode.css';

interface ImageSelection {
  box: PdfBox;
  blob: Blob;
  anchor: Anchor;
  left: number;
  top: number;
}

interface ImageDrag {
  pointerId: number;
  start: Anchor;
}

const HIGHLIGHT_COLORS = ['#6f9ec7', '#c79a6f', '#9a7fc7', '#62ad8b', '#c76f8e'];

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function dragBox(start: Anchor, current: Anchor): PdfBox {
  const x = Math.max(0, Math.min(start.x, current.x));
  const y = Math.max(0, Math.min(start.y, current.y));
  const right = Math.max(0, Math.min(1, Math.max(start.x, current.x)));
  const bottom = Math.max(0, Math.min(1, Math.max(start.y, current.y)));
  return { x, y, w: right - x, h: bottom - y };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function cropImage(image: HTMLImageElement, box: PdfBox): Promise<Blob> {
  const sx = Math.round(box.x * image.naturalWidth);
  const sy = Math.round(box.y * image.naturalHeight);
  const width = Math.max(2, Math.round(box.w * image.naturalWidth));
  const height = Math.max(2, Math.round(box.h * image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图片选区画布');
  context.drawImage(image, sx, sy, width, height, 0, 0, width, height);
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error('图片选区生成失败');
  return blob;
}

export default function ImageNode({ id, data, selected }: NodeProps<ConversationNode>) {
  const askFromSelection = useStore(state => state.askFromSelection);
  const activeProvider = useStore(state => state.activeProvider);
  const providers: ProviderInfo[] = useStore(state => state.providers);
  const quickActions = useStore(state => state.quickActions);
  const probeEdges = useStore(useShallow(state => state.edges.filter(edge => edge.source === id && edge.data.kind === 'probe')));
  const updateHighlightAnchor = useStore(state => state.updateHighlightAnchor);
  const { getViewport } = useReactFlow();
  const nodeRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<ImageDrag | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [aspectRatio, setAspectRatio] = useState(1);
  const [preview, setPreview] = useState<PdfBox | null>(null);
  const [selection, setSelection] = useState<ImageSelection | null>(null);
  const [question, setQuestion] = useState('');
  const [selectionCopied, setSelectionCopied] = useState(false);
  const [error, setError] = useState('');
  const fileId = data.fileId ?? '';
  const fileName = data.fileName ?? '';
  const selectedModel = data.model ?? activeProvider;
  const selectedModelInputs = selectedModel
    ? providers.find(provider => provider.id === selectedModel.providerId)?.modelInputs?.[selectedModel.modelId]
    : undefined;
  const modelInputs: readonly ModelInput[] = selectedModelInputs ?? ['text'];
  const supportsImages = modelInputs.includes('image');
  const capabilityVerified = selectedModel
    ? providers.find(provider => provider.id === selectedModel.providerId)?.modelInputStatus?.[selectedModel.modelId] === 'verified'
    : false;
  const previewColor = HIGHLIGHT_COLORS[probeEdges.length % HIGHLIGHT_COLORS.length];

  function highlightColor(highlightId: string): string {
    const edge = probeEdges.find(item => item.data.highlightId === highlightId);
    const index = edge ? probeEdges.indexOf(edge) : -1;
    return HIGHLIGHT_COLORS[(index < 0 ? 0 : index) % HIGHLIGHT_COLORS.length];
  }

  function finishSelection(): void {
    dragRef.current = null;
    setSelection(null);
    setPreview(null);
    setQuestion('');
    setSelectionCopied(false);
  }

  useOnViewportChange({ onStart: finishSelection });

  useLayoutEffect(() => {
    const node = nodeRef.current;
    const preview = previewRef.current;
    if (!node || !preview) return;
    const updateAnchors = (): void => {
      const nodeRect = node.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      const zoom = getViewport().zoom || 1;
      for (const highlight of data.highlights ?? []) {
        const boxes = highlight.boxes;
        if (!boxes?.length) continue;
        const box = boxes[boxes.length - 1];
        updateHighlightAnchor(id, highlight.id, {
          x: nodeRect.width / zoom,
          y: (previewRect.top + (box.y + box.h / 2) * previewRect.height - nodeRect.top) / zoom,
        });
      }
    };
    const observer = new ResizeObserver(updateAnchors);
    observer.observe(node);
    observer.observe(preview);
    updateAnchors();
    return () => observer.disconnect();
  }, [data.highlights, getViewport, id, updateHighlightAnchor]);

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    finishSelection();
    readPdfFile(fileId).then((record: StoredPdfFile | null) => {
      if (!record) {
        if (active) setError('没有找到图片原件，请重新拖入');
        return;
      }
      objectUrl = URL.createObjectURL(record.blob);
      if (active) setImageUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  useEffect(() => {
    if (!selection) return;
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.image-quote-popup') && !event.target.closest('.image-select-surface')) finishSelection();
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [selection]);

  function resizeNode(naturalWidth: number, naturalHeight: number): void {
    const ratio = naturalWidth / naturalHeight;
    setAspectRatio(ratio);
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    let width = node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : Math.min(560, naturalWidth));
    let height = width / ratio;
    if (height > 720) {
      height = 720;
      width = height * ratio;
    }
    if (height < 120) {
      height = 120;
      width = height * ratio;
    }
    if (width < 160) {
      width = 160;
      height = width / ratio;
    }
    useStore.getState().onNodesChange([{
      id,
      type: 'dimensions',
      resizing: false,
      setAttributes: true,
      dimensions: { width: Math.round(width), height: Math.round(height) },
    }]);
  }

  function imagePoint(event: ReactPointerEvent<HTMLDivElement>): Anchor {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function startSelection(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !imageUrl) return;
    event.preventDefault();
    const start = imagePoint(event);
    dragRef.current = { pointerId: event.pointerId, start };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection(null);
    setPreview({ ...start, w: 0, h: 0 });
  }

  function moveSelection(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreview(dragBox(drag.start, imagePoint(event)));
  }

  async function endSelection(event: ReactPointerEvent<HTMLDivElement>): Promise<void> {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const box = dragBox(drag.start, imagePoint(event));
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const image = imageRef.current;
    const node = nodeRef.current;
    if (box.w * rect.width < 6 || box.h * rect.height < 6 || !image || !node) {
      finishSelection();
      return;
    }
    try {
      const blob = await cropImage(image, box);
      if (dragRef.current !== drag) return;
      dragRef.current = null;
      const zoom = getViewport().zoom || 1;
      const nodeRect = node.getBoundingClientRect();
      const left = Math.max(12, Math.min(rect.left + box.x * rect.width, window.innerWidth - 392));
      const selectionBottom = rect.top + (box.y + box.h) * rect.height;
      const top = selectionBottom + 160 < window.innerHeight ? selectionBottom + 8 : rect.top + box.y * rect.height - 152;
      setPreview(box);
      setSelection({
        box,
        blob,
        left,
        top,
        anchor: {
          x: nodeRect.width / zoom,
          y: (rect.top + (box.y + box.h / 2) * rect.height - nodeRect.top) / zoom,
        },
      });
      setQuestion('');
      setSelectionCopied(false);
    } catch (cause) {
      if (dragRef.current !== drag) return;
      finishSelection();
      setError(errorMessage(cause));
    }
  }

  async function submitTask(task: string, displayQuestion = task): Promise<void> {
    if (!selection || !task.trim()) return;
    const activeSelection = selection;
    const imageAssetId = crypto.randomUUID();
    try {
      await savePdfFile(imageAssetId, new File([activeSelection.blob], `${fileName}-region.png`, { type: 'image/png' }));
    } catch (cause) {
      setError(`图片保存失败：${errorMessage(cause)}`);
      return;
    }
    askFromSelection({
      sourceId: id,
      quote: `【图片选区：${fileName}】`,
      highlightQuote: '图片选区',
      textStart: null,
      anchor: activeSelection.anchor,
      question: displayQuestion,
      prompt: `用户框选了图片《${fileName}》中的一个区域，并附上该选区图片。用户要求：${task}\n请直接基于选区图片回答，不要要求用户重新提供图片。若要求是翻译且未指定目标语言，请将选区中的外文翻译为中文，保留术语与原意。`,
      imageAssetId,
      highlightMeta: { boxes: [activeSelection.box], kind: 'image' },
    });
    finishSelection();
  }

  function runQuickAction(action: QuickAction): void {
    if (!selection) return;
    void submitTask(buildQuickActionPrompt(action), action.label);
  }

  async function copySelection(): Promise<void> {
    if (!selection) return;
    try {
      if (!navigator.clipboard.write || typeof ClipboardItem === 'undefined') throw new Error('当前浏览器不支持复制图片');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': selection.blob })]);
      setSelectionCopied(true);
      setTimeout(() => setSelectionCopied(false), 1800);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div ref={nodeRef} className={`conversation-node assistant image-node ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-kind">图片 · {fileName}</div>
      <NodeResizeCorners id={id} minWidth={120} minHeight={80} aspectRatio={aspectRatio} onResizeStart={finishSelection} />
      <NodeCard className="assistant image-card">
        <div ref={previewRef} className="image-preview nodrag nowheel">
          {imageUrl ? <img ref={imageRef} src={imageUrl} alt={fileName} onLoad={event => resizeNode(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : <div className="image-status">{error || '正在读取图片…'}</div>}
          {imageUrl && (
            <div
              className="image-select-surface"
              role="application"
              aria-label="框选图片区域"
              onPointerDown={startSelection}
              onPointerMove={moveSelection}
              onPointerUp={event => void endSelection(event)}
              onPointerCancel={finishSelection}
            />
          )}
          {(data.highlights ?? []).flatMap(highlight => (highlight.boxes ?? []).map((box, index) => {
            const color = highlightColor(highlight.id);
            return (
              <div
                key={`${highlight.id}-${index}`}
                className="image-selection-box"
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, borderColor: color, background: `${color}24` }}
              />
            );
          }))}
          {preview && <div className="image-selection-box" style={{ left: `${preview.x * 100}%`, top: `${preview.y * 100}%`, width: `${preview.w * 100}%`, height: `${preview.h * 100}%`, borderColor: previewColor, background: `${previewColor}24` }} />}
        </div>
      </NodeCard>
      <Handle type="source" position={Position.Right} />
      {selection && createPortal(
        <div className="quote-popup image-quote-popup nodrag nowheel" style={{ left: selection.left, top: selection.top }}>
          <div className="surface quote-popup-row">
            <input
              className="quote-input"
              aria-label="就图片选区提问"
              autoFocus
              value={question}
              placeholder="补充说明或提问，Enter 发送"
              onChange={event => setQuestion(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submitTask(question);
              }}
            />
            <div className="quote-fixed-actions" role="group" aria-label="固定操作">
              <button type="button" className="quote-action" onClick={() => void copySelection()}>{selectionCopied ? '已复制' : '复制图片'}</button>
            </div>
          </div>
          <div className="quote-presets" role="group" aria-label="快捷提问">
            {quickActions.map(action => (
              <button key={action.id} type="button" className="quote-action" onClick={() => runQuickAction(action)}>{action.label}</button>
            ))}
          </div>
          {!supportsImages && <div className="image-capability warning">{capabilityVerified ? '当前模型不支持图片' : '当前模型未确认视觉能力'}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
