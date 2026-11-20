/**
 * 节点放置的纯几何逻辑：就近优先——宁可局部小重叠，不远距离传送。
 *
 * 从 store.ts 抽出以便 Node 单测直接运行。只依赖结构化节点形状
 * （position/measured/style/data.role），不依赖 React Flow 运行时。
 */

import type { CSSProperties } from 'react';
import type { XYPosition } from '@xyflow/react';
import { DEFAULT_ANSWER_SIZE, DEFAULT_INTERACTIVE_SIZE, DEFAULT_MULTI_INTERACTIVE_SIZE, DEFAULT_MULTI_MODEL_SIZE, NODE_VERTICAL_GAP } from './session.ts';

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
  data?: { role?: string; nodeType?: string; generationKind?: 'answer' | 'interactive' } | undefined;
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
    w: node.measured?.width ?? numericDimension(node.style?.width, role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.width : role === 'assistant' ? DEFAULT_ANSWER_SIZE.width : node.data?.nodeType === 'multi' ? DEFAULT_MULTI_MODEL_SIZE.width : 280),
    h: node.measured?.height ?? numericDimension(node.style?.height, role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.height : role === 'assistant' ? DEFAULT_ANSWER_SIZE.height : node.data?.nodeType === 'multi' ? (node.data.generationKind === 'interactive' ? DEFAULT_MULTI_INTERACTIVE_SIZE.height : DEFAULT_MULTI_MODEL_SIZE.height) : 120),
  };
}

export function placementOverlaps(a: PlacementBounds, b: PlacementBounds): boolean {
  return a.x < b.x + b.w + NODE_GAP
    && a.x + a.w + NODE_GAP > b.x
    && a.y < b.y + b.h + NODE_VERTICAL_GAP
    && a.y + a.h + NODE_VERTICAL_GAP > b.y;
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
  const stepY = Math.round(size.h + NODE_VERTICAL_GAP);
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

function childDesiredPosition(source: PlacementNode, size: PlacementSize, anchorY: number): XYPosition {
  const bounds = placementNodeBounds(source);
  return {
    x: bounds.x + bounds.w + 56,
    y: bounds.y + Math.max(0, anchorY - size.h / 2),
  };
}

export function findChildPosition(
  source: PlacementNode,
  size: PlacementSize,
  nodes: readonly PlacementNode[],
  anchorY = 0,
): XYPosition {
  return findFreePosition(childDesiredPosition(source, size, anchorY), size, nodes);
}

export interface IdentifiedPlacementNode extends PlacementNode {
  id: string;
}

export interface ChildPlacement {
  position: XYPosition;
  relocations: ReadonlyMap<string, XYPosition>;
}

export interface MultiChildPlacement {
  positions: XYPosition[];
  relocations: ReadonlyMap<string, XYPosition>;
}

export function makeRoomForPosition(
  position: XYPosition,
  size: PlacementSize,
  nodes: readonly IdentifiedPlacementNode[],
): ChildPlacement {
  const rounded = { x: Math.round(position.x), y: Math.round(position.y) };
  const boundsById = new Map(nodes.map(node => [node.id, placementNodeBounds(node)]));
  const relocations = new Map<string, XYPosition>();
  const queue: (PlacementBounds & { id?: string })[] = [{ ...rounded, ...size }];
  const maxCascadeSteps = Math.max(32, nodes.length * 4);
  for (let index = 0; index < queue.length; index += 1) {
    if (index >= maxCascadeSteps) {
      return { position: findFreePosition(rounded, size, nodes), relocations: new Map<string, XYPosition>() };
    }
    const area = queue[index];
    if (!area) continue;
    const currentArea = area.id ? boundsById.get(area.id) : undefined;
    if (area.id && currentArea && (currentArea.x !== area.x || currentArea.y !== area.y)) continue;
    for (const node of nodes) {
      if (area.id === node.id) continue;
      const current = boundsById.get(node.id);
      if (!current || !placementOverlaps(area, current)) continue;
      const y = area.y + area.h + NODE_VERTICAL_GAP;
      if (y <= current.y) continue;
      const next = { ...current, y, id: node.id };
      boundsById.set(node.id, next);
      relocations.set(node.id, { x: next.x, y });
      queue.push(next);
    }
  }
  return { position: rounded, relocations };
}

export function makeRoomForMultiChildren(
  source: IdentifiedPlacementNode,
  size: PlacementSize,
  count: number,
  nodes: readonly IdentifiedPlacementNode[],
): MultiChildPlacement {
  if (count <= 0) return { positions: [], relocations: new Map<string, XYPosition>() };
  const sourceBounds = placementNodeBounds(source);
  const groupHeight = count * size.h + (count - 1) * NODE_VERTICAL_GAP;
  const groupOrigin = {
    x: Math.round(sourceBounds.x + sourceBounds.w + 56),
    y: Math.round(sourceBounds.y + sourceBounds.h / 2 - groupHeight / 2),
  };
  const { relocations } = makeRoomForPosition(groupOrigin, { w: size.w, h: groupHeight }, nodes);
  return {
    positions: Array.from({ length: count }, (_, index) => ({
      x: groupOrigin.x,
      y: groupOrigin.y + index * (size.h + NODE_VERTICAL_GAP),
    })),
    relocations,
  };
}

export function makeRoomForChild(
  source: IdentifiedPlacementNode,
  size: PlacementSize,
  nodes: readonly IdentifiedPlacementNode[],
  anchorY = 0,
): ChildPlacement {
  return makeRoomForPosition(childDesiredPosition(source, size, anchorY), size, nodes);
}
