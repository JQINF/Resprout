const EDGE_KINDS = new Set(['derive', 'probe', 'challenge', 'belong']);

export const DEFAULT_ANSWER_SIZE = { width: 720, height: 480 };
export const INTERACTIVE_ASPECT_RATIO = 3 / 2;
export const DEFAULT_INTERACTIVE_SPLIT_RATIO = 0.62;
const INTERACTIVE_RIGHT_SPACE = 254;

export function interactiveNodeSize(width, splitRatio = DEFAULT_INTERACTIVE_SPLIT_RATIO) {
  const outerRatio = INTERACTIVE_ASPECT_RATIO / splitRatio;
  let nextWidth = Math.max(320, width, INTERACTIVE_RIGHT_SPACE / (1 - splitRatio));
  let nextHeight = nextWidth / outerRatio;
  if (nextHeight < 240) {
    nextHeight = 240;
    nextWidth = nextHeight * outerRatio;
  }
  return { width: Math.round(nextWidth), height: Math.round(nextHeight) };
}

export function interactiveFreeSize(width, height) {
  const nextHeight = Math.max(240, height);
  const minWidth = nextHeight * INTERACTIVE_ASPECT_RATIO + INTERACTIVE_RIGHT_SPACE;
  return { width: Math.round(Math.max(320, width, minWidth)), height: Math.round(nextHeight) };
}

export const DEFAULT_INTERACTIVE_SIZE = interactiveNodeSize(960);

export function createSession() {
  return {
    id: crypto.randomUUID(),
    title: '未命名探索',
    template: 'learning',
    createdAt: new Date().toISOString(),
  };
}

export function exportSession(session, nodes, edges) {
  return JSON.stringify({
    schemaVersion: 1,
    session: { ...session, updatedAt: new Date().toISOString() },
    nodes: nodes.map(node => {
      const status = node.data.pending
        ? 'interrupted'
        : node.data.fallback
          ? 'fallback'
          : node.data.error
            ? 'failed'
            : 'ready';
      return {
        id: node.id,
        type: node.data.nodeType,
        role: node.data.role ?? 'user',
        status,
        summary: node.data.generationDiagnostic?.summary ?? '',
        content: node.data.content,
        title: node.data.title ?? null,
        fileId: node.data.fileId ?? null,
        fileName: node.data.fileName ?? null,
        assetKind: node.data.assetKind ?? null,
        mimeType: node.data.mimeType ?? null,
        imageAssetId: node.data.imageAssetId ?? null,
        pageCount: node.data.pageCount ?? 0,
        contextText: node.data.contextText ?? '',
        contextTruncated: Boolean(node.data.contextTruncated),
        explanation: node.data.explanation ?? '',
        prompt: node.data.prompt ?? null,
        model: node.data.model ?? null,
        usage: node.data.usage ?? null,
        position: node.position,
        width: node.measured?.width ?? node.style?.width ?? 300,
        height: node.measured?.height ?? node.style?.height ?? 200,
        collapsed: false,
        createdAt: node.data.createdAt ?? null,
        highlights: node.data.highlights ?? [],
      };
    }),
    edges: edges.map(edge => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      kind: edge.data?.kind ?? 'derive',
      thinking: edge.data?.thinking ?? '',
      quote: edge.data?.quote ?? '',
      anchor: edge.data?.anchor ?? null,
      highlight: edge.data?.highlightId ?? null,
      fromHandle: edge.sourceHandle ?? null,
    })),
  }, null, 2);
}

export function importSession(text) {
  const value = JSON.parse(text);
  if (value.schemaVersion !== 1 || !value.session || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('不是受支持的 Resprout Session 文件');
  }

  const ids = new Set();
  for (const node of value.nodes) {
    if (!node.id || ids.has(node.id) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) {
      throw new Error('节点 ID 或位置无效');
    }
    ids.add(node.id);
  }

  const targets = new Set();
  for (const edge of value.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || targets.has(edge.to) || !EDGE_KINDS.has(edge.kind)) {
      throw new Error('连线无效：每个节点只能有一个主父节点');
    }
    targets.add(edge.to);
  }

  return {
    session: {
      id: String(value.session.id ?? crypto.randomUUID()),
      title: String(value.session.title ?? '未命名探索'),
      template: value.session.template === 'project' ? 'project' : 'learning',
      createdAt: String(value.session.createdAt ?? new Date().toISOString()),
    },
    nodes: value.nodes.map(node => {
      const role = node.role === 'interactive' ? 'interactive' : node.role === 'assistant' ? 'assistant' : node.role === 'reference' ? 'reference' : 'user';
      const interactive = role === 'interactive';
      const reference = role === 'reference';
      const summary = typeof node.summary === 'string' ? node.summary : '';
      const status = node.status === 'fallback' || node.status === 'failed' || node.status === 'interrupted' ? node.status : null;
      return {
        id: node.id,
        type: interactive ? 'interactive' : reference ? (node.assetKind === 'image' ? 'image' : 'pdf') : 'conversation',
        position: node.position,
        style: role === 'assistant' || interactive || reference
          ? {
              width: Number.isFinite(node.width) ? Math.max(interactive ? 320 : reference ? 360 : 220, node.width) : reference ? 600 : interactive ? DEFAULT_INTERACTIVE_SIZE.width : DEFAULT_ANSWER_SIZE.width,
              height: Number.isFinite(node.height) ? Math.max(interactive ? 240 : reference ? 320 : 150, node.height) : reference ? 680 : interactive ? DEFAULT_INTERACTIVE_SIZE.height : DEFAULT_ANSWER_SIZE.height,
            }
          : undefined,
        data: {
          nodeType: interactive ? 'interactive' : reference ? 'reference' : node.type ?? 'chat',
          role,
          title: typeof node.title === 'string' ? node.title : interactive ? '交互解释' : '',
          fileId: reference ? String(node.fileId ?? node.id) : undefined,
          fileName: reference ? String(node.fileName ?? node.title ?? 'PDF 文档') : undefined,
          assetKind: reference ? node.assetKind ?? 'pdf' : undefined,
          mimeType: reference ? node.mimeType ?? null : undefined,
          imageAssetId: node.imageAssetId ? String(node.imageAssetId) : null,
          pageCount: reference && Number.isFinite(node.pageCount) ? node.pageCount : 0,
          contextText: reference ? String(node.contextText ?? '') : undefined,
          contextTruncated: reference ? Boolean(node.contextTruncated) : false,
          content: String(node.content ?? ''),
          explanation: typeof node.explanation === 'string' ? node.explanation : '',
          prompt: typeof node.prompt === 'string' ? node.prompt : null,
          model: node.model && typeof node.model.providerId === 'string' && typeof node.model.modelId === 'string'
            ? { providerId: node.model.providerId, modelId: node.model.modelId }
            : null,
          usage: node.usage && typeof node.usage === 'object' ? node.usage : null,
          pending: false,
          reviewing: false,
          reviewAttempt: 0,
          previewContent: '',
          fallback: status === 'fallback',
          error: status === 'failed' ? (summary || '此卡片上次生成失败，请重新生成') : status === 'interrupted' ? '生成在会话保存时中断，请重新生成' : '',
          generationDiagnostic: summary ? { stage: 'restored', attempts: 0, durationMs: 0, summary } : null,
          createdAt: Number.isFinite(node.createdAt) ? node.createdAt : Date.now(),
          highlights: sanitizeHighlights(node.highlights),
        },
      };
    }),
    edges: value.edges.map(edge => ({
      id: edge.id ?? crypto.randomUUID(),
      source: edge.from,
      target: edge.to,
      type: 'thinking',
      ...(typeof edge.fromHandle === 'string' && edge.fromHandle ? { sourceHandle: edge.fromHandle } : {}),
      data: {
        kind: edge.kind,
        thinking: String(edge.thinking ?? ''),
        streaming: false,
        error: '',
        quote: String(edge.quote ?? ''),
        anchor: sanitizeAnchor(edge.anchor),
        highlightId: typeof edge.highlight === 'string' && edge.highlight ? edge.highlight : null,
      },
    })),
  };
}

function sanitizeHighlights(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => item && typeof item.quote === 'string' && item.quote.trim())
    .map(item => ({
      id: String(item.id ?? crypto.randomUUID()),
      quote: item.quote,
      textStart: Number.isInteger(item.textStart) ? item.textStart : null,
      anchor: sanitizeAnchor(item.anchor),
      ...(Number.isInteger(item.pageNumber) && item.pageNumber > 0 ? { pageNumber: item.pageNumber } : {}),
      ...(item.kind === 'image' ? { kind: 'image' } : {}),
      ...(Array.isArray(item.boxes) ? { boxes: sanitizePdfBoxes(item.boxes) } : {}),
    }));
}

function sanitizePdfBoxes(value) {
  return value.filter(box => [box?.x, box?.y, box?.w, box?.h].every(Number.isFinite)).map(box => ({
    x: Math.max(0, Math.min(1, box.x)),
    y: Math.max(0, Math.min(1, box.y)),
    w: Math.max(0, Math.min(1, box.w)),
    h: Math.max(0, Math.min(1, box.h)),
  })).filter(box => box.w > 0 && box.h > 0);
}

function sanitizeAnchor(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}
