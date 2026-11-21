import type { XYPosition } from '@xyflow/react';
import { interactiveFreeSize } from './session.ts';
import type { NodeRole } from './session.ts';

export interface SelectionGeometryNode {
  id: string;
  position: XYPosition;
  width: number;
  height: number;
  role: NodeRole;
  errorInset?: number;
}

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectionScaledNode {
  id: string;
  position: XYPosition;
  dimensions: { width: number; height: number };
}

export function selectionBounds(nodes: readonly SelectionGeometryNode[]): SelectionBounds | null {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map(node => node.position.x));
  const minY = Math.min(...nodes.map(node => node.position.y));
  const maxX = Math.max(...nodes.map(node => node.position.x + node.width));
  const maxY = Math.max(...nodes.map(node => node.position.y + node.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function minimumDimensions(node: SelectionGeometryNode): { width: number; height: number } {
  if (node.role === 'interactive') return { width: 320, height: 240 };
  if (node.role === 'reference') return { width: 360, height: 320 };
  if (node.role === 'assistant') return { width: 220, height: 150 };
  return { width: 120, height: 60 };
}

export function scaleSelectionNodes(
  nodes: readonly SelectionGeometryNode[],
  requestedScale: number,
  origin: XYPosition,
): SelectionScaledNode[] {
  const minimumScale = Math.max(0.1, ...nodes.map(node => {
    const minimum = minimumDimensions(node);
    return Math.max(minimum.width / node.width, minimum.height / node.height);
  }));
  const scale = Math.min(8, Math.max(minimumScale, Number.isFinite(requestedScale) ? requestedScale : 1));
  return nodes.map(node => {
    const requested = { width: node.width * scale, height: node.height * scale };
    const minimum = minimumDimensions(node);
    const dimensions = node.role === 'interactive'
      ? interactiveFreeSize(requested.width, requested.height, node.errorInset ?? 0)
      : {
          width: Math.max(minimum.width, Math.round(requested.width)),
          height: Math.max(minimum.height, Math.round(requested.height)),
        };
    return {
      id: node.id,
      position: {
        x: origin.x + (node.position.x - origin.x) * scale,
        y: origin.y + (node.position.y - origin.y) * scale,
      },
      dimensions,
    };
  });
}
