import { isQuickActionPrompt } from './quick-actions.js';

export function plainPreview(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^(?:\s*(?:>\s*|[-+*]\s+|\d+[.)、]\s*|#{1,6}\s+))+/gm, '')
    .replace(/\*\*|__|\x60/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutGreeting(text) {
  return text
    .replace(/^(?:奶奶(?:[您你]?好[呀啊]?)?|您好|你好|好孩子|乖孙)[，,。！!\s]+/u, '')
    .replace(/^(?:奶奶给你|我(?:来|给您|给你|用)).{0,28}(?:讲|解释|比方)[^。！？!?：:]{0,12}[。！？!?：:]\s*/u, '')
    .trim();
}

function answerPreview(content) {
  const text = content.replace(/^`{3}[^\n]*\n[\s\S]*?^`{3}[^\n]*/gm, '').trim();
  const headings = text.matchAll(/^[ \t]*(?:#{1,6}[ \t]+(.+?)[ \t]*#*|\*\*([^*\n]+)\*\*)[ \t]*$/gm);
  for (const heading of headings) {
    const label = withoutGreeting(plainPreview(heading[1] ?? heading[2]));
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

export function buildBranchTrees(nodes, edges, mainlineChoices = {}) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const parentById = new Map();
  const edgeByTarget = new Map();
  const childrenById = new Map(nodes.map(node => [node.id, []]));

  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target || parentById.has(edge.target)) continue;
    parentById.set(edge.target, edge.source);
    edgeByTarget.set(edge.target, edge);
    childrenById.get(edge.source).push(edge.target);
  }
  for (const children of childrenById.values()) {
    children.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
  }

  function pageOf(edge, source) {
    const highlight = source.data.highlights?.find(item => item.id === edge.data?.highlightId);
    return highlight?.pageNumber ?? (Number(edge.data?.quote?.match(/第\s*(\d+)\s*页/u)?.[1]) || null);
  }

  function quickActionContent(nodeId) {
    const node = nodeById.get(nodeId);
    const edge = edgeByTarget.get(nodeId);
    if (edge?.data?.kind !== 'probe' || !isQuickActionPrompt(node.data.prompt)) return {};

    const source = nodeById.get(edge.source);
    const highlight = source.data.highlights?.find(item => item.id === edge.data.highlightId);
    if ((source.type !== 'pdf' && source.data.assetKind !== 'pdf') || highlight?.kind === 'text') {
      const detail = highlight?.quote ?? edge.data.quote ?? '';
      return { preview: plainPreview(detail), detail };
    }

    for (const childId of childrenById.get(nodeId)) {
      const answer = nodeById.get(childId);
      if (edgeByTarget.get(childId)?.data?.kind !== 'derive' || answer.data.role !== 'assistant' || answer.data.pending || answer.data.error) continue;
      const detail = answer.data.content ?? '';
      const preview = answerPreview(detail);
      if (preview) return { preview, detail };
    }

    const page = pageOf(edge, source);
    const regions = new Map();
    for (const childId of childrenById.get(source.id)) {
      const sibling = edgeByTarget.get(childId);
      if (sibling.data?.kind !== 'probe' || pageOf(sibling, source) !== page) continue;
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

  const subtreeSize = rootId => {
    const pending = [rootId];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      for (const childId of childrenById.get(id) ?? []) pending.push(childId);
    }
    return visited.size;
  };

  const rootIds = nodes.filter(node => !parentById.has(node.id)).map(node => node.id);
  const reachable = new Set();
  const pending = [...rootIds];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const childId of childrenById.get(id) ?? []) pending.push(childId);
  }
  for (const node of nodes) if (!reachable.has(node.id)) rootIds.push(node.id);

  return rootIds.map(rootId => {
    const mainline = [];
    const visited = new Set();
    let currentId = rootId;
    while (nodeById.has(currentId) && !visited.has(currentId)) {
      visited.add(currentId);
      const children = childrenById.get(currentId) ?? [];
      const chosen = mainlineChoices[currentId];
      const nextId = children.includes(chosen)
        ? chosen
        : children.find(childId => edgeByTarget.get(childId)?.data?.kind === 'derive') ?? null;
      mainline.push({
        node: nodeById.get(currentId),
        ...quickActionContent(currentId),
        branches: children.filter(childId => childId !== nextId).map(childId => ({
          id: childId,
          parentId: currentId,
          node: nodeById.get(childId),
          ...quickActionContent(childId),
          nodeCount: subtreeSize(childId),
        })),
      });
      currentId = nextId;
    }
    return { id: rootId, mainline };
  });
}
