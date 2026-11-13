import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { NodeDimensionChange, NodePositionChange, XYPosition } from '@xyflow/react';
import { DEFAULT_ANSWER_SIZE, DEFAULT_INTERACTIVE_SIZE, interactiveFreeSize } from './session.ts';
import { useStore } from './store.ts';

type ResizeDirection = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

interface NodeResizeCornersProps {
  id: string;
  minWidth?: number;
  minHeight?: number;
  aspectRatio?: number;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onResize?: (width: number, height: number) => void;
}

const DIRECTIONS: readonly ResizeDirection[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

function cssSize(value: CSSProperties['width'] | CSSProperties['height']): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export default function NodeResizeCorners({ id, minWidth, minHeight, aspectRatio, onResizeStart, onResizeEnd, onResize }: NodeResizeCornersProps) {
  const { getViewport } = useReactFlow();

  function startResize(event: ReactPointerEvent<HTMLSpanElement>, direction: ResizeDirection): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    const node = useStore.getState().nodes.find(item => item.id === id);
    if (!node) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const zoom = getViewport().zoom || 1;
    const startPosition: XYPosition = { ...node.position };
    const startWidth = node.measured?.width ?? cssSize(node.style?.width) ?? (node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.width : DEFAULT_ANSWER_SIZE.width);
    const startHeight = node.measured?.height ?? cssSize(node.style?.height) ?? (node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.height : DEFAULT_ANSWER_SIZE.height);
    const minimumWidth = minWidth ?? (node.data.role === 'interactive' ? 320 : 220);
    const minimumHeight = minHeight ?? (node.data.role === 'interactive' ? 240 : 150);
    let width = startWidth;
    let height = startHeight;
    let position = startPosition;
    let ended = false;

    const apply = (nextWidth: number, nextHeight: number, nextPosition: XYPosition, resizing: boolean): void => {
      const changes: (NodeDimensionChange | NodePositionChange)[] = [{
        id,
        type: 'dimensions',
        resizing,
        setAttributes: true,
        dimensions: { width: nextWidth, height: nextHeight },
      }];
      if (direction.includes('left') || direction.includes('top')) {
        changes.push({ id, type: 'position', position: nextPosition });
      }
      useStore.getState().onNodesChange(changes);
      onResize?.(nextWidth, nextHeight);
    };
    const move = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startX) / zoom;
      const dy = (moveEvent.clientY - startY) / zoom;
      width = Math.max(minimumWidth, startWidth + (direction.includes('right') ? dx : direction.includes('left') ? -dx : 0));
      height = Math.max(minimumHeight, startHeight + (direction.includes('bottom') ? dy : direction.includes('top') ? -dy : 0));
      if (node.data.role === 'interactive') {
        const next = interactiveFreeSize(width, height);
        width = next.width;
        height = next.height;
      } else if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
        const widthDrivenHeight = width / aspectRatio;
        const heightDrivenWidth = height * aspectRatio;
        if (Math.abs(widthDrivenHeight - startHeight) >= Math.abs(heightDrivenWidth - startWidth)) {
          height = widthDrivenHeight;
        } else {
          width = heightDrivenWidth;
        }
      }
      position = {
        x: direction.includes('left') ? startPosition.x - (width - startWidth) : startPosition.x,
        y: direction.includes('top') ? startPosition.y - (height - startHeight) : startPosition.y,
      };
      apply(width, height, position, true);
    };
    const finish = (): void => {
      if (ended) return;
      ended = true;
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      apply(width, height, position, false);
      onResizeEnd?.();
    };

    onResizeStart?.();
    element.setPointerCapture(event.pointerId);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
  }

  return DIRECTIONS.map(direction => (
    <span
      key={direction}
      className={`node-resize-corner nodrag ${direction}`}
      aria-hidden="true"
      onPointerDown={event => startResize(event, direction)}
    />
  ));
}
