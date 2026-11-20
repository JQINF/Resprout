import type { XYPosition } from '@xyflow/react';
import { DEFAULT_ANSWER_SIZE, DEFAULT_INTERACTIVE_SIZE, DEFAULT_MULTI_INTERACTIVE_SIZE, DEFAULT_MULTI_MODEL_SIZE, NODE_VERTICAL_GAP, multiModelGenerationKind } from './session.ts';
import type { ConversationEdge, ConversationNode } from './session.ts';
import { styleDimension } from './node-utils.ts';

type NodeMetrics = { width: number; height: number };
type SubtreeMetrics = { height: number; childrenHeight: number };
type LayoutBox = { positions: Map<string, XYPosition>; width: number; height: number };
type BoxPlacement = { box: LayoutBox; x: number; y: number };
type LayoutRectangle = { id: string; position: XYPosition; width: number; height: number };
type LayoutLane = { rectangles: LayoutRectangle[]; top: number; left: number };

export function tidyLayout<T extends ConversationNode>(nodes: T[], edges: ConversationEdge[]): T[] {
  if (nodes.length < 2) return nodes;
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const linked = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const branchEdgeOf = new Map<string, ConversationEdge>();
  for (const node of nodes) linked.set(node.id, []);
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    linked.get(edge.source)?.push(edge.target);
    linked.get(edge.target)?.push(edge.source);
    if (parentOf.has(edge.target)) continue;
    parentOf.set(edge.target, edge.source);
    branchEdgeOf.set(edge.target, edge);
    const children = childrenOf.get(edge.source);
    if (children) children.push(edge.target);
    else childrenOf.set(edge.source, [edge.target]);
  }
  for (const [sourceId, children] of childrenOf) {
    const source = nodeById.get(sourceId);
    const infoByChild = new Map<string, { textStart?: number; anchorY?: number }>();
    for (const id of children) {
      const edge = branchEdgeOf.get(id);
      const highlight = source?.data.highlights?.find(item => item.id === edge?.data?.highlightId);
      infoByChild.set(id, {
        textStart: highlight?.textStart ?? undefined,
        anchorY: highlight?.anchor?.y ?? edge?.data?.anchor?.y,
      });
    }
    const useTextOrder = children.every(id => Number.isInteger(infoByChild.get(id)?.textStart));
    const positionOf = (id: string) => {
      const info = infoByChild.get(id);
      const value = useTextOrder ? info?.textStart : info?.anchorY;
      return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
    };
    children.sort((a, b) => {
      const positionA = positionOf(a);
      const positionB = positionOf(b);
      if (positionA !== positionB) return positionA - positionB;
      return (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0);
    });
  }
  const metrics = new Map<string, NodeMetrics>();
  for (const node of nodes) {
    const fallbackWidth = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.width : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE.width : node.data.nodeType === 'multi' ? DEFAULT_MULTI_MODEL_SIZE.width : 300;
    const fallbackHeight = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE.height : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE.height : node.data.nodeType === 'multi' ? (multiModelGenerationKind(node.data) === 'interactive' ? DEFAULT_MULTI_INTERACTIVE_SIZE.height : DEFAULT_MULTI_MODEL_SIZE.height) : 140;
    metrics.set(node.id, {
      width: Math.max(120, Math.round(node.measured?.width ?? styleDimension(node.style?.width) ?? fallbackWidth)),
      height: Math.max(60, Math.round(node.measured?.height ?? styleDimension(node.style?.height) ?? fallbackHeight)),
    });
  }
  const gapX = 72;
  const gapY = NODE_VERTICAL_GAP;
  const rootGapY = 48;

  const componentOf = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (componentOf.has(node.id)) continue;
    const ids: string[] = [];
    const stack = [node.id];
    componentOf.add(node.id);
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined) continue;
      ids.push(id);
      for (const next of linked.get(id) ?? []) {
        if (componentOf.has(next)) continue;
        componentOf.add(next);
        stack.push(next);
      }
    }
    components.push(ids);
  }

  const layoutComponent = (ids: string[]): LayoutBox => {
    const componentIds = new Set(ids);
    const rootIds = ids.filter(id => {
      const parentId = parentOf.get(id);
      return !parentId || !componentIds.has(parentId);
    });
    const subtreeOf = new Map<string, SubtreeMetrics>();
    const childrenIn = (id: string) => (childrenOf.get(id) ?? []).filter(childId => componentIds.has(childId));

    const measureTree = (id: string, path: Set<string>): SubtreeMetrics | null => {
      const cached = subtreeOf.get(id);
      if (cached) return cached;
      if (path.has(id)) return null;
      path.add(id);
      const size = metrics.get(id);
      if (!size) return null;
      let childrenHeight = 0;
      let count = 0;
      for (const childId of childrenIn(id)) {
        const child = measureTree(childId, path);
        if (!child) continue;
        childrenHeight += child.height + gapY;
        count += 1;
      }
      if (count) childrenHeight -= gapY;
      const subtree = { height: Math.max(size.height, childrenHeight), childrenHeight };
      subtreeOf.set(id, subtree);
      path.delete(id);
      return subtree;
    };
    for (const id of [...rootIds, ...ids]) {
      if (!subtreeOf.has(id)) measureTree(id, new Set());
    }

    const positions = new Map<string, XYPosition>();
    const place = (id: string, top: number, left: number) => {
      const subtree = subtreeOf.get(id);
      const size = metrics.get(id);
      if (positions.has(id) || !subtree || !size) return;
      positions.set(id, { x: left, y: top });
      const children = childrenIn(id).filter(childId => subtreeOf.has(childId) && !positions.has(childId));
      let cursor = top + Math.max(0, (subtree.height - subtree.childrenHeight) / 2);
      for (const childId of children) {
        const childSubtree = subtreeOf.get(childId);
        if (!childSubtree) continue;
        place(childId, cursor, left + size.width + gapX);
        cursor += childSubtree.height + gapY;
      }
      let y = top + (subtree.height - size.height) / 2;
      if (children.length) {
        const first = children[0];
        const last = children[children.length - 1];
        if (first && last) {
          const firstPosition = positions.get(first);
          const lastPosition = positions.get(last);
          const firstSize = metrics.get(first);
          const lastSize = metrics.get(last);
          if (firstPosition && lastPosition && firstSize && lastSize) {
            const firstCenter = firstPosition.y + firstSize.height / 2;
            const lastCenter = lastPosition.y + lastSize.height / 2;
            y = (firstCenter + lastCenter - size.height) / 2;
            y = Math.max(top, Math.min(top + subtree.height - size.height, y));
          }
        }
      }
      positions.set(id, { x: left, y });
    };
    let rootCursor = 0;
    for (const id of [...rootIds, ...ids]) {
      if (positions.has(id)) continue;
      place(id, rootCursor, 0);
      rootCursor += (subtreeOf.get(id)?.height ?? metrics.get(id)?.height ?? 0) + rootGapY;
    }

    const mainlineChild = (id: string): string | undefined => {
      const children = childrenIn(id).filter(childId => positions.has(childId));
      return children.length === 1 ? children[0] : undefined;
    };
    const lanes: LayoutLane[] = [];
    const assigned = new Set<string>();
    for (const id of [...rootIds, ...ids]) {
      if (assigned.has(id) || !positions.has(id)) continue;
      const rectangles: LayoutRectangle[] = [];
      let current: string | undefined = id;
      while (current && componentIds.has(current) && !assigned.has(current)) {
        const position = positions.get(current);
        const size = metrics.get(current);
        if (!position || !size) break;
        assigned.add(current);
        rectangles.push({ id: current, position: { ...position }, ...size });
        current = mainlineChild(current);
      }
      if (!rectangles.length) continue;
      lanes.push({
        rectangles,
        top: Math.min(...rectangles.map(rectangle => rectangle.position.y)),
        left: Math.min(...rectangles.map(rectangle => rectangle.position.x)),
      });
    }
    lanes.sort((a, b) => a.top - b.top
      || a.left - b.left
      || (indexById.get(a.rectangles[0]?.id ?? '') ?? 0) - (indexById.get(b.rectangles[0]?.id ?? '') ?? 0));
    const horizontallyOverlap = (a: LayoutRectangle, b: LayoutRectangle) => (
      a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x
    );
    const placed: LayoutLane[] = [];
    for (const lane of lanes) {
      let top = 0;
      for (const rectangle of lane.rectangles) {
        for (const otherLane of placed) {
          for (const other of otherLane.rectangles) {
            if (horizontallyOverlap(rectangle, other)) {
              top = Math.max(top, other.position.y + other.height + gapY);
            }
          }
        }
      }
      for (const rectangle of lane.rectangles) rectangle.position.y = top;
      placed.push(lane);
    }
    for (const lane of placed) {
      for (const rectangle of lane.rectangles) positions.set(rectangle.id, rectangle.position);
    }

    const verticalPairs: { upperId: string; lowerId: string }[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const a = ids[index];
      const aPosition = positions.get(a);
      const aSize = metrics.get(a);
      if (!aPosition || !aSize) continue;
      for (let otherIndex = index + 1; otherIndex < ids.length; otherIndex += 1) {
        const b = ids[otherIndex];
        const bPosition = positions.get(b);
        const bSize = metrics.get(b);
        if (!bPosition || !bSize) continue;
        if (!horizontallyOverlap({ id: a, position: aPosition, ...aSize }, { id: b, position: bPosition, ...bSize })) continue;
        const [upperId, lowerId] = aPosition.y <= bPosition.y ? [a, b] : [b, a];
        verticalPairs.push({ upperId, lowerId });
      }
    }
    const shiftSubtree = (id: string, delta: number, visited = new Set<string>()): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const position = positions.get(id);
      if (position) position.y += delta;
      for (const childId of childrenIn(id)) shiftSubtree(childId, delta, visited);
    };
    const centerParents = (): void => {
      const centered = new Set<string>();
      const center = (id: string): void => {
        if (centered.has(id)) return;
        centered.add(id);
        const children = childrenIn(id).filter(childId => positions.has(childId));
        for (const childId of children) center(childId);
        const parentPosition = positions.get(id);
        const parentSize = metrics.get(id);
        const first = children[0];
        const last = children[children.length - 1];
        if (!parentPosition || !parentSize || !first || !last) return;
        const firstPosition = positions.get(first);
        const lastPosition = positions.get(last);
        const firstSize = metrics.get(first);
        const lastSize = metrics.get(last);
        if (!firstPosition || !lastPosition || !firstSize || !lastSize) return;
        parentPosition.y = (firstPosition.y + firstSize.height / 2 + lastPosition.y + lastSize.height / 2 - parentSize.height) / 2;
      };
      for (const id of ids) center(id);
    };
    centerParents();
    const maxCenteringPasses = Math.max(64, ids.length * ids.length);
    for (let pass = 0; pass < maxCenteringPasses; pass += 1) {
      let shifted = false;
      for (const { upperId, lowerId } of verticalPairs) {
        const upper = positions.get(upperId);
        const lower = positions.get(lowerId);
        const upperSize = metrics.get(upperId);
        if (!upper || !lower || !upperSize) continue;
        const delta = upper.y + upperSize.height + gapY - lower.y;
        if (delta <= 0) continue;
        shiftSubtree(lowerId, delta);
        shifted = true;
      }
      centerParents();
      if (!shifted) break;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const [id, position] of positions) {
      const size = metrics.get(id);
      if (!size) continue;
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x + size.width);
      maxY = Math.max(maxY, position.y + size.height);
    }
    if (!Number.isFinite(minX)) return { positions, width: 0, height: 0 };
    for (const position of positions.values()) {
      position.x -= minX;
      position.y -= minY;
    }
    return { positions, width: maxX - minX, height: maxY - minY };
  };

  const boxes = components.map(ids => layoutComponent(ids));
  const gap = 56;
  let totalArea = 0;
  let widest = 0;
  for (const box of boxes) {
    totalArea += box.width * box.height;
    widest = Math.max(widest, box.width);
  }
  const candidateWidths = new Set<number>([widest, widest * 1.5, Number.POSITIVE_INFINITY]);
  for (const aspect of [1.6, 2, 2.4, 3]) candidateWidths.add(Math.sqrt(totalArea * aspect));
  let best: { placements: BoxPlacement[]; score: number } | null = null;
  for (const rawWidth of candidateWidths) {
    const maxWidth = Math.max(widest, rawWidth);
    const ordered = [...boxes].sort((a, b) => b.width * b.height - a.width * a.height);
    const placements: BoxPlacement[] = [];
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    let width = 0;
    for (const box of ordered) {
      if (cursorX > 0 && cursorX + box.width > maxWidth) {
        cursorX = 0;
        cursorY += rowHeight + gap;
        rowHeight = 0;
      }
      placements.push({ box, x: cursorX, y: cursorY });
      cursorX += box.width + gap;
      rowHeight = Math.max(rowHeight, box.height);
      width = Math.max(width, cursorX - gap);
    }
    const height = cursorY + rowHeight;
    const aspect = width / Math.max(1, height);
    const score = width * height * (1 + 0.12 * Math.abs(Math.log(aspect / 2)));
    if (!best || score < best.score) best = { placements, score };
  }
  if (!best) return nodes;
  const positions = new Map<string, XYPosition>();
  for (const { box, x, y } of best.placements) {
    for (const [id, position] of box.positions) {
      positions.set(id, { x: x + position.x, y: y + position.y });
    }
  }
  for (const node of nodes) {
    if (!positions.has(node.id)) positions.set(node.id, { x: 0, y: 0 });
  }
  return nodes.map(node => {
    const position = positions.get(node.id) ?? node.position;
    return {
      ...node,
      position: { x: Math.round(position.x), y: Math.round(position.y) },
    };
  });
}
