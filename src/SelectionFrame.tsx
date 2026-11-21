import type { PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow, ViewportPortal } from '@xyflow/react';
import type { NodeChange, XYPosition } from '@xyflow/react';
import { selectionBounds, scaleSelectionNodes } from './selection-transform.ts';
import type { SelectionGeometryNode } from './selection-transform.ts';
import { INTERACTIVE_ERROR_BAR_INSET } from './session.ts';
import type { ConversationNode } from './session.ts';
import { useStore } from './store.ts';

type ResizeDirection = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface SelectionFrameProps {
  nodes: ConversationNode[];
  getSize(node: ConversationNode): { width: number; height: number };
  onGestureChange?(active: boolean): void;
}

const DIRECTIONS: readonly ResizeDirection[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const FRAME_PADDING = 24;

export default function SelectionFrame({ nodes, getSize, onGestureChange }: SelectionFrameProps) {
  const { getViewport } = useReactFlow();
  const selected = nodes.filter(node => node.selected);
  if (selected.length < 2) return null;
  const geometries = selected.map(node => geometryOf(node, getSize));
  const bounds = selectionBounds(geometries);
  if (!bounds) return null;

  function startMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const zoom = getViewport().zoom || 1;
    const startPositions = useStore.getState().nodes.filter(node => node.selected).map(node => ({ id: node.id, position: { ...node.position } }));
    if (startPositions.length < 2) return;
    let delta: XYPosition = { x: 0, y: 0 };
    let ended = false;

    const apply = (dragging: boolean): void => {
      useStore.getState().onNodesChange(startPositions.map(node => ({
        id: node.id,
        type: 'position',
        position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
        dragging,
      })));
    };
    const move = (moveEvent: PointerEvent): void => {
      delta = { x: (moveEvent.clientX - startX) / zoom, y: (moveEvent.clientY - startY) / zoom };
      apply(true);
    };
    const finish = (): void => {
      if (ended) return;
      ended = true;
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      apply(false);
      onGestureChange?.(false);
    };

    onGestureChange?.(true);
    try { element.setPointerCapture(event.pointerId); } catch {}
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>, direction: ResizeDirection): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const current = useStore.getState().nodes.filter(node => node.selected);
    const startGeometries = current.map(node => geometryOf(node, getSize));
    const startBounds = selectionBounds(startGeometries);
    if (startGeometries.length < 2 || !startBounds || !startBounds.width || !startBounds.height) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const zoom = getViewport().zoom || 1;
    const origin = {
      x: direction.includes('left') ? startBounds.x + startBounds.width : startBounds.x,
      y: direction.includes('top') ? startBounds.y + startBounds.height : startBounds.y,
    };
    let scale = 1;
    let ended = false;

    const apply = (resizing: boolean): void => {
      const scaled = scaleSelectionNodes(startGeometries, scale, origin);
      const changes: NodeChange<ConversationNode>[] = scaled.flatMap(node => [
        { id: node.id, type: 'dimensions', resizing, setAttributes: true, dimensions: node.dimensions },
        { id: node.id, type: 'position', position: node.position, dragging: resizing },
      ]);
      useStore.getState().onNodesChange(changes);
    };
    const move = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startX) / zoom;
      const dy = (moveEvent.clientY - startY) / zoom;
      const horizontal = (startBounds.width + (direction.includes('right') ? dx : -dx)) / startBounds.width;
      const vertical = (startBounds.height + (direction.includes('bottom') ? dy : -dy)) / startBounds.height;
      scale = Math.abs(horizontal - 1) >= Math.abs(vertical - 1) ? horizontal : vertical;
      apply(true);
    };
    const finish = (): void => {
      if (ended) return;
      ended = true;
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      apply(false);
      onGestureChange?.(false);
    };

    onGestureChange?.(true);
    try { element.setPointerCapture(event.pointerId); } catch {}
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
  }

  return (
    <ViewportPortal>
      <div
        className="selection-frame nodrag nopan"
        role="group"
        aria-label={`已选择 ${selected.length} 个节点`}
        style={{
          left: bounds.x - FRAME_PADDING,
          top: bounds.y - FRAME_PADDING,
          width: bounds.width + FRAME_PADDING * 2,
          height: bounds.height + FRAME_PADDING * 2,
        }}
      >
        <div className="selection-frame-label" onPointerDown={startMove}>{selected.length} 个节点</div>
        {(['top', 'right', 'bottom', 'left'] as const).map(direction => (
          <div key={direction} className={`selection-frame-edge ${direction}`} onPointerDown={startMove} />
        ))}
        {DIRECTIONS.map(direction => (
          <div key={direction} className={`selection-frame-corner ${direction}`} onPointerDown={event => startResize(event, direction)} />
        ))}
      </div>
    </ViewportPortal>
  );
}

function geometryOf(node: ConversationNode, getSize: SelectionFrameProps['getSize']): SelectionGeometryNode {
  const size = getSize(node);
  return {
    id: node.id,
    position: { ...node.position },
    width: size.width,
    height: size.height,
    role: node.data.role,
    errorInset: node.data.role === 'interactive' && node.data.error ? INTERACTIVE_ERROR_BAR_INSET : 0,
  };
}
