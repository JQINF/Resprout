/**
 * 节点放置的纯几何逻辑：就近优先——宁可局部小重叠，不远距离传送。
 *
 * 从 store.ts 抽出以便 Node 单测直接运行。只依赖结构化节点形状
 * （position/measured/style/data.role），不依赖 React Flow 运行时。
 */

import type { CSSProperties } from 'react';
import type { XYPosition } from '@xyflow/react';
import { DEFAULT_ANSWER_SIZE, DEFAULT_INTERACTIVE_SIZE } from './session.ts';

const NODE_GAP = 40;
/** 空位扫描上限：先右后下，最多 4 列 × 6 行；更大范围宁可以小错位重叠。 */
const MAX_SEARCH_COLUMNS = 4;
const MAX_SEARCH_ROWS = 6;
/** 完全找不到空位时的确定性小错位（允许与邻居轻微重叠，由用户拖动整理）。 */
const FALLBACK_STAGGER = 32;

export interface PlacementNode {
  position: XYPosition;
  measured?: { width?: number; height?: number } | undefined;
  style?: { width?: CSSProperties['width']; height?: CSSProperties['height'] } | undefined;
  data?: { role?: string } | undefined;
}

export interface PlacementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacementSize {
  w: number;
  h: number;
}

function numericDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function placementNodeBounds(node: PlacementNode): PlacementBounds {
  const role = node.data?.role;
  return {
    x: node.position.x,
    y: node.position.y,
    w: node.measured?.width ?? numericDimension(node.style?.width, role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.width : role === 'assistant' ? DEFAULT_ANSWER_SIZE.width : 280),
    h: node.measured?.height ?? numericDimension(node.style?.height, role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.height : role === 'assistant' ? DEFAULT_ANSWER_SIZE.height : 120),
  };
}

export function placementOverlaps(a: PlacementBounds, b: PlacementBounds): boolean {
  return a.x < b.x + b.w + NODE_GAP
    && a.x + a.w + NODE_GAP > b.x
    && a.y < b.y + b.h + NODE_GAP
    && a.y + a.h + NODE_GAP > b.y;
}

/**
 * 以期望位置为原点找空位：原点空闲则原样返回；被占用时先右后下按节点尺寸步进扫描
 * （限 4 列 × 6 行）；找不到就返回期望位置 + 32px 错位，绝不弹到远处。
 */
export function findFreePosition(position: XYPosition, size: PlacementSize, nodes: readonly PlacementNode[]): XYPosition {
  const others = nodes.map(placementNodeBounds);
  const fits = (x: number, y: number): boolean => !others.some(bounds => placementOverlaps({ x, y, w: size.w, h: size.h }, bounds));
  if (fits(position.x, position.y)) return { x: Math.round(position.x), y: Math.round(position.y) };

  const stepX = Math.round(size.w + NODE_GAP);
  const stepY = Math.round(size.h + NODE_GAP);
  for (let column = 0; column <= MAX_SEARCH_COLUMNS; column += 1) {
    for (let row = 0; row <= MAX_SEARCH_ROWS; row += 1) {
      if (column === 0 && row === 0) continue;
      const x = position.x + column * stepX;
      const y = position.y + row * stepY;
      if (fits(x, y)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return { x: Math.round(position.x + FALLBACK_STAGGER), y: Math.round(position.y + FALLBACK_STAGGER) };
}
