import { useMemo, useRef } from 'react';
import { Position } from '@xyflow/react';
import { DEFAULT_ANSWER_SIZE, DEFAULT_INTERACTIVE_SIZE } from './session.ts';
import type { ConversationEdge, ConversationNode } from './session.ts';

type FlowNodeCache = {
  source: ConversationNode;
  zIndex: number;
  value: ConversationNode;
};

type FlowEdgeCache = {
  sourceEdge: ConversationEdge;
  source: string;
  zIndex: number;
  checkpoint: boolean;
  anchor: ConversationEdge['data']['anchor'];
  highlightId: string | null | undefined;
  value: ConversationEdge;
};

function nodeSize(node: ConversationNode): { width: number; height: number } {
  const fallback = node.data.role === 'interactive' ? DEFAULT_INTERACTIVE_SIZE
    : node.data.role === 'assistant' ? DEFAULT_ANSWER_SIZE : { width: 280, height: 120 };
  return {
    width: node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : fallback.width),
    height: node.measured?.height ?? (typeof node.style?.height === 'number' ? node.style.height : fallback.height),
  };
}

function nodeHandles(node: ConversationNode): ConversationNode['handles'] {
  const { width, height } = nodeSize(node);
  return [
    { id: null, type: 'target', position: Position.Left, x: -6, y: height / 2 - 6, width: 12, height: 12 },
    { id: 'right', type: 'source', position: Position.Right, x: width - 6, y: height / 2 - 6, width: 12, height: 12 },
    ...(node.data.role === 'assistant'
      ? [{ id: 'left', type: 'source' as const, position: Position.Left, x: -6, y: height * 0.75 - 6, width: 12, height: 12 }]
      : []),
  ];
}

function answeredQuestionIds(nodes: ConversationNode[], edges: ConversationEdge[]): Set<string> {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  return new Set(edges
    .filter(edge => nodeById.get(edge.source)?.data.nodeType === 'question' && nodeById.get(edge.target)?.data.role === 'assistant')
    .map(edge => edge.source));
}

export function visibleLayoutGraph(nodes: ConversationNode[], edges: ConversationEdge[]): { nodes: ConversationNode[]; edges: ConversationEdge[] } {
  const checkpoints = answeredQuestionIds(nodes, edges);
  const incomingByTarget = new Map(edges.map(edge => [edge.target, edge]));
  return {
    nodes: nodes.filter(node => !checkpoints.has(node.id)),
    edges: edges.flatMap(edge => {
      if (checkpoints.has(edge.target)) return [];
      if (checkpoints.has(edge.source)) {
        const incoming = incomingByTarget.get(edge.source);
        return incoming ? [{
          ...edge,
          source: incoming.source,
          data: {
            ...edge.data,
            anchor: incoming.data?.anchor ?? edge.data?.anchor,
            highlightId: incoming.data?.highlightId ?? edge.data?.highlightId,
          },
        }] : [];
      }
      return [edge];
    }),
  };
}

export function useFlowGraph(nodes: ConversationNode[], edges: ConversationEdge[]): {
  flowNodes: ConversationNode[];
  flowEdges: ConversationEdge[];
} {
  const nodeCache = useRef(new Map<string, FlowNodeCache>());
  const edgeCache = useRef(new Map<string, FlowEdgeCache>());

  return useMemo(() => {
    const nodeLayers = new Map<string, number>();
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const incomingByTarget = new Map(edges.map(edge => [edge.target, edge]));
    const answeredQuestions = answeredQuestionIds(nodes, edges);
    const nextNodeCache = new Map<string, FlowNodeCache>();
    const flowNodes = nodes.flatMap((node, index) => {
      if (answeredQuestions.has(node.id)) return [];
      const zIndex = 2 * (index + 1 + (node.selected ? nodes.length : 0));
      nodeLayers.set(node.id, zIndex);
      const previous = nodeCache.current.get(node.id);
      const cached = previous?.source === node && previous.zIndex === zIndex ? previous : null;
      const value = cached?.value ?? {
        ...node,
        handles: node.handles ?? nodeHandles(node),
        draggable: node.data.nodeType !== 'question' || !answeredQuestions.has(node.id),
        dragHandle: '.node-drag-edge, .question-collapsed-mark',
        zIndex,
      };
      nextNodeCache.set(node.id, cached ?? { source: node, zIndex, value });
      return [value];
    });
    const nextEdgeCache = new Map<string, FlowEdgeCache>();
    const flowEdges = edges.flatMap(edge => {
      if (answeredQuestions.has(edge.target)) return [];
      let source = edge.source;
      let connectionData = edge.data;
      let checkpoint = false;
      let anchor = edge.data?.anchor;
      let highlightId = edge.data?.highlightId;
      if (answeredQuestions.has(edge.source) && nodeById.get(edge.target)?.data.role === 'assistant') {
        const incoming = incomingByTarget.get(edge.source);
        if (!incoming) return [];
        source = incoming.source;
        checkpoint = true;
        anchor = incoming.data?.anchor ?? anchor;
        highlightId = incoming.data?.highlightId ?? highlightId;
        connectionData = {
          ...connectionData,
          checkpoint,
          anchor,
          highlightId,
        };
      }
      const sourceLayer = nodeLayers.get(source) ?? 2;
      const targetLayer = nodeLayers.get(edge.target) ?? 2;
      const zIndex = Math.max(0, Math.max(sourceLayer, targetLayer) - 1);
      const previous = edgeCache.current.get(edge.id);
      const cached = previous?.sourceEdge === edge
        && previous.source === source
        && previous.zIndex === zIndex
        && previous.checkpoint === checkpoint
        && previous.anchor === anchor
        && previous.highlightId === highlightId
        ? previous
        : null;
      const value = cached?.value ?? {
        ...edge,
        source,
        zIndex,
        data: { ...connectionData, renderLayer: zIndex },
      };
      nextEdgeCache.set(edge.id, cached ?? { sourceEdge: edge, source, zIndex, checkpoint, anchor, highlightId, value });
      return [value];
    });
    nodeCache.current = nextNodeCache;
    edgeCache.current = nextEdgeCache;
    return { flowNodes, flowEdges };
  }, [nodes, edges]);
}
