export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MeasuredRect extends RectLike {
  cy: number;
}

interface TextLine {
  cy: number;
  h: number;
  n: number;
  rects: MeasuredRect[];
}

interface TextRangePart {
  node: Text;
  start: number;
  end: number;
}

function isTextNode(node: Node | null): node is Text {
  return node !== null && node.nodeType === Node.TEXT_NODE;
}

function createTextWalker(root: Node): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      return node.parentElement?.closest('.katex-mathml, script, style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
}

export function clusterLineRects(rects: readonly RectLike[], gap = 8): RectLike[] {
  const items: MeasuredRect[] = rects
    .filter(rect => rect.w > 0.5 && rect.h > 0.5)
    .map(rect => ({ ...rect, cy: rect.y + rect.h / 2 }));
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  const lines: TextLine[] = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(item.cy - line.cy) <= Math.max(10, line.h * 0.55)) {
      line.rects.push(item);
      line.cy = (line.cy * line.n + item.cy) / (line.n + 1);
      line.h = Math.max(line.h, item.h);
      line.n += 1;
    } else {
      lines.push({ cy: item.cy, h: item.h, n: 1, rects: [item] });
    }
  }
  return lines.flatMap(line => {
    const row = line.rects.sort((a, b) => a.x - b.x);
    const [first, ...rest] = row;
    if (!first) return [];
    const runs: RectLike[] = [];
    let current: RectLike = { x: first.x, y: first.y, w: first.w, h: first.h };
    for (const rect of rest) {
      if (rect.x - (current.x + current.w) <= gap) {
        const right = Math.max(current.x + current.w, rect.x + rect.w);
        const bottom = Math.max(current.y + current.h, rect.y + rect.h);
        current.x = Math.min(current.x, rect.x);
        current.y = Math.min(current.y, rect.y);
        current.w = right - current.x;
        current.h = bottom - current.y;
      } else {
        runs.push(current);
        current = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      }
    }
    runs.push(current);
    return runs;
  });
}

function textRangeParts(range: Range, root: Node): TextRangePart[] {
  const walker = createTextWalker(root);
  const parts: TextRangePart[] = [];
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isTextNode(node) && range.intersectsNode(node)) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (start < end) parts.push({ node, start, end });
    }
    node = walker.nextNode();
  }
  return parts;
}

export function textRangeRects(range: Range, root: Node): RectLike[] {
  const rects: RectLike[] = [];
  for (const part of textRangeParts(range, root)) {
    let start = part.start;
    let end = part.end;
    const selected = part.node.data.slice(start, end);
    start += selected.match(/^\s*/)?.[0].length ?? 0;
    end -= selected.match(/\s*$/)?.[0].length ?? 0;
    if (start >= end) continue;
    const textRange = document.createRange();
    textRange.setStart(part.node, start);
    textRange.setEnd(part.node, end);
    for (const rect of Array.from(textRange.getClientRects())) {
      if (rect.width > 0.5 && rect.height > 0.5) {
        rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    }
  }
  return clusterLineRects(rects);
}

export function quoteTextRects(root: Node | null, quote: string | null): RectLike[] | null {
  if (!root || !quote) return null;
  const walker = createTextWalker(root);
  const nodes: Array<{ node: Text; start: number }> = [];
  let haystack = '';
  let node: Node | null = walker.nextNode();
  while (node) {
    if (isTextNode(node)) {
      nodes.push({ node, start: haystack.length });
      haystack += node.data;
    }
    node = walker.nextNode();
  }
  const normMap: number[] = [];
  let normalized = '';
  for (let index = 0; index < haystack.length; index += 1) {
    const character = haystack.charAt(index);
    if (/\s/.test(character) || /[\u200b\u200c\u200d\ufeff]/.test(character)) continue;
    normMap.push(index);
    normalized += character;
  }
  const normalizedQuote = quote.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
  const quoteIndex = normalized.indexOf(normalizedQuote);
  if (quoteIndex < 0 || !normalizedQuote) return null;
  const startIndex = normMap.at(quoteIndex);
  const lastIndex = normMap.at(quoteIndex + normalizedQuote.length - 1);
  if (startIndex === undefined || lastIndex === undefined) return null;
  const endIndex = lastIndex + 1;
  const range = document.createRange();
  let started = false;
  for (const { node: textNode, start } of nodes) {
    const length = textNode.data.length;
    if (!started && startIndex < start + length) {
      range.setStart(textNode, startIndex - start);
      started = true;
    }
    if (started && endIndex <= start + length) {
      range.setEnd(textNode, endIndex - start);
      const rects = textRangeRects(range, root);
      return rects.length ? rects : null;
    }
  }
  return null;
}

export function normalizedRangeStart(root: Node, range: Range): number {
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return textRangeParts(prefix, root).reduce((length, { node, start, end }) =>
    length + node.data.slice(start, end).replace(/[\s\u200b\u200c\u200d\ufeff]/g, '').length, 0);
}
