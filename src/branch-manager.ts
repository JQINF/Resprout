import { isQuickActionPrompt } from './quick-actions.ts';
import type { ConversationEdge, ConversationNode } from './session.ts';

export function plainPreview(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^(?:\s*(?:>\s*|[-+*]\s+|\d+[.)、]\s*|#{1,6}\s+))+/gm, '')
    .replace(/\*\*|__|\x60/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutGreeting(text: string): string {
  return text
    .replace(/^(?:奶奶(?:[您你]?好[呀啊]?)?|您好|你好|好孩子|乖孙)[，,。！!\s]+/u, '')
    .replace(/^(?:奶奶给你|我(?:来|给您|给你|用)).{0,28}(?:讲|解释|比方)[^。！？!?：:]{0,12}[。！？!?：:]\s*/u, '')
    .trim();
}

function answerPreview(content: string): string {
  const text = content.replace(/^`{3}[^\n]*\n[\s\S]*?^`{3}[^\n]*/gm, '').trim();
  const headings = text.matchAll(/^[ \t]*(?:#{1,6}[ \t]+(.+?)[ \t]*#*|\*\*([^*\n]+)\*\*)[ \t]*$/gm);
  for (const heading of headings) {
    const label = withoutGreeting(plainPreview(heading[1] ?? heading[2] ?? ''));
    if (label && !/^(?:引言|简介|背景|概述|核心概念|核心内容|解释|答案|举个例子|总结|结论|一句话总结)[：:。]?$/u.test(label)) {
      return label;
    }
  }
  for (const paragraph of text.split(/\n\s*\n/)) {
    const preview = withoutGreeting(plainPreview(paragraph));
    if (/[\p{L}\p{N}]/u.test(preview)) return preview;
  }
  return '';
}

interface BranchContent {
  preview?: string;
  detail?: string;
}

export interface BranchSideItem {
  id: string;
  parentId: string;
  node: ConversationNode;
  nodeCount: number;
  preview?: string;
  detail?: string;
}

export interface BranchMainlineItem {
  node: ConversationNode;
  preview?: string;
  detail?: string;
  branches: BranchSideItem[];
}

export interface BranchTree {
  id: string;
  mainline: BranchMainlineItem[];
}

export function buildBranchTrees(
  nodes: ConversationNode[],
  edges: ConversationEdge[],
  mainlineChoices: Record<string, string> = {},
): BranchTree[] {
  const nodeById = new Map<string, ConversationNode>(nodes.map(node => [node.id, node]));
  const indexById = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
  const parentById = new Map<string, string>();
  const edgeByTarget = new Map<string, ConversationEdge>();
  const childrenById = new Map<string, string[]>(nodes.map(node => [node.id, []]));

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target || parentById.has(edge.target)) continue;
    parentById.set(edge.target, edge.source);
    edgeByTarget.set(edge.target, edge);
    childrenById.get(edge.source)?.push(edge.target);
  }
  for (const children of childrenById.values()) {
    children.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
  }

  function pageOf(edge: ConversationEdge, source: ConversationNode): number | null {
    const highlight = source.data.highlights?.find(item => item.id === edge.data?.highlightId);
    return highlight?.pageNumber ?? (Number(edge.data?.quote?.match(/第\s*(\d+)\s*页/u)?.[1]) || null);
  }

  function quickActionContent(nodeId: string): BranchContent {
    const node = nodeById.get(nodeId);
    const edge = edgeByTarget.get(nodeId);
    if (!node || edge?.data?.kind !== 'probe' || !isQuickActionPrompt(node.data.prompt)) return {};

    const source = nodeById.get(edge.source);
    if (!source) return {};
    const highlight = source.data.highlights?.find(item => item.id === edge.data.highlightId);
    if ((source.type !== 'pdf' && source.data.assetKind !== 'pdf') || highlight?.kind === 'text') {
      const detail = highlight?.quote ?? edge.data.quote ?? '';
      return { preview: plainPreview(detail), detail };
    }

    for (const childId of childrenById.get(nodeId) ?? []) {
      const answer = nodeById.get(childId);
      if (!answer || edgeByTarget.get(childId)?.data?.kind !== 'derive' || answer.data.role !== 'assistant' || answer.data.pending || answer.data.error) continue;
      const detail = answer.data.content ?? '';
      const preview = answerPreview(detail);
      if (preview) return { preview, detail };
    }

    const page = pageOf(edge, source);
    const regions = new Map<string, number>();
    for (const childId of childrenById.get(source.id) ?? []) {
      const sibling = edgeByTarget.get(childId);
      if (!sibling || sibling.data?.kind !== 'probe' || pageOf(sibling, source) !== page) continue;
      const regionId = sibling.data.highlightId ?? sibling.id;
      if (!regions.has(regionId)) regions.set(regionId, regions.size + 1);
      if (childId === nodeId) break;
    }
    const region = regions.get(edge.data.highlightId ?? edge.id);
    return {
      preview: page ? `第 ${page} 页 · 选区 ${region}` : `PDF 选区 ${region}`,
      detail: edge.data.quote ?? '',
    };
  }

  const subtreeSize = (rootId: string): number => {
    const pending = [rootId];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      for (const childId of childrenById.get(id) ?? []) pending.push(childId);
    }
    return visited.size;
  };

  const rootIds = nodes.filter(node => !parentById.has(node.id)).map(node => node.id);
  const reachable = new Set<string>();
  const pending = [...rootIds];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const childId of childrenById.get(id) ?? []) pending.push(childId);
  }
  for (const node of nodes) if (!reachable.has(node.id)) rootIds.push(node.id);

  return rootIds.map(rootId => {
    const mainline: BranchMainlineItem[] = [];
    const visited = new Set<string>();
    let currentId: string | null = rootId;
    while (currentId !== null && nodeById.has(currentId) && !visited.has(currentId)) {
      visited.add(currentId);
      const parentId: string = currentId;
      const node = nodeById.get(currentId);
      if (!node) break;
      const children: string[] = childrenById.get(currentId) ?? [];
      const chosen: string | undefined = mainlineChoices[currentId];
      const nextId: string | null = chosen && children.includes(chosen)
        ? chosen
        : children.find(childId => edgeByTarget.get(childId)?.data?.kind === 'derive') ?? null;
      mainline.push({
        node,
        ...quickActionContent(parentId),
        branches: children
          .filter(childId => childId !== nextId)
          .flatMap(childId => {
            const branchNode = nodeById.get(childId);
            return branchNode
              ? [{
                  id: childId,
                  parentId,
                  node: branchNode,
                  ...quickActionContent(childId),
                  nodeCount: subtreeSize(childId),
                }]
              : [];
          }),
      });
      currentId = nextId;
    }
    return { id: rootId, mainline };
  });
}
