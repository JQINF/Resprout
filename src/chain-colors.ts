import type { ConversationEdge } from './session.ts';

export type ChainColor = { stroke: string; soft: string; border: string; fill: string };

export const CHAIN_COLORS: ChainColor[] = [
  { stroke: '#6f9ec7', soft: 'rgba(111, 158, 199, 0.36)', border: '#c3d2e2', fill: '#f0f5fb' },
  { stroke: '#c79a6f', soft: 'rgba(199, 154, 111, 0.36)', border: '#e2cdb8', fill: '#faf3ec' },
  { stroke: '#9a7fc7', soft: 'rgba(154, 127, 199, 0.36)', border: '#d0c4e4', fill: '#f4effb' },
  { stroke: '#62ad8b', soft: 'rgba(98, 173, 139, 0.36)', border: '#bed9cb', fill: '#edf6f1' },
  { stroke: '#c76f8e', soft: 'rgba(199, 111, 142, 0.36)', border: '#e4c2cf', fill: '#fbeef3' },
];

export function chainColorIndex(edges: ConversationEdge[], edge: ConversationEdge | null | undefined): number {
  if (!edge) return -1;
  const colorEdge = edge.data?.highlightId
    ? edges.find(item => item.source === edge.source && item.data?.kind === 'probe' && item.data?.highlightId === edge.data?.highlightId) ?? edge
    : edge;
  const probes = edges.filter(item => item.source === colorEdge.source && item.data?.kind === 'probe');
  const index = probes.indexOf(colorEdge);
  return index < 0 ? -1 : index % CHAIN_COLORS.length;
}
