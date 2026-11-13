export function clusterLineRects(rects, gap = 8) {
  const items = rects
    .filter(rect => rect.w > 0.5 && rect.h > 0.5)
    .map(rect => ({ ...rect, cy: rect.y + rect.h / 2 }));
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const item of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(item.cy - line.cy) <= Math.max(10, line.h * 0.55)) {
      line.rects.push(item);
      line.cy = (line.cy * line.n + item.cy) / (line.n + 1);
      line.h = Math.max(line.h, item.h);
      line.n += 1;
    } else {
      lines.push({ cy: item.cy, h: item.h, n: 1, rects: [item] });
    }
  }
  return lines.map(line => {
    const row = line.rects.sort((a, b) => a.x - b.x);
    const runs = [];
    let current = { x: row[0].x, y: row[0].y, w: row[0].w, h: row[0].h };
    for (let i = 1; i < row.length; i += 1) {
      const rect = row[i];
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
  }).flat();
}

export function textRangeParts(range, root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, node =>
    node.parentElement?.closest('.katex-mathml, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  const parts = [];
  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node)) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      if (start < end) parts.push({ node, start, end });
    }
    node = walker.nextNode();
  }
  return parts;
}

export function textRangeRects(range, root) {
  const rects = [];
  for (const { node, start: initialStart, end: initialEnd } of textRangeParts(range, root)) {
    let start = initialStart;
    let end = initialEnd;
    const selected = node.data.slice(start, end);
    start += selected.match(/^\s*/)[0].length;
    end -= selected.match(/\s*$/)[0].length;
    if (start >= end) continue;
    const textRange = document.createRange();
    textRange.setStart(node, start);
    textRange.setEnd(node, end);
    for (const rect of textRange.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) {
        rects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      }
    }
  }
  return clusterLineRects(rects);
}

export function quoteTextRects(root, quote) {
  if (!root || !quote) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, node =>
    node.parentElement?.closest('.katex-mathml, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  const nodes = [];
  let haystack = '';
  let node = walker.nextNode();
  while (node) {
    nodes.push({ node, start: haystack.length });
    haystack += node.data;
    node = walker.nextNode();
  }
  const normMap = [];
  let normalized = '';
  for (let index = 0; index < haystack.length; index += 1) {
    const character = haystack[index];
    if (/\s/.test(character) || /[\u200b\u200c\u200d\ufeff]/.test(character)) continue;
    normMap.push(index);
    normalized += character;
  }
  const normalizedQuote = quote.replace(/[\s\u200b\u200c\u200d\ufeff]/g, '');
  const quoteIndex = normalized.indexOf(normalizedQuote);
  if (quoteIndex < 0 || !normalizedQuote) return null;
  const startIndex = normMap[quoteIndex];
  const endIndex = normMap[quoteIndex + normalizedQuote.length - 1] + 1;
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

export function normalizedRangeStart(root, range) {
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return textRangeParts(prefix, root).reduce((length, { node, start, end }) =>
    length + node.data.slice(start, end).replace(/[\s\u200b\u200c\u200d\ufeff]/g, '').length, 0);
}
