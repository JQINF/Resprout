import type { Edge, Node } from '@xyflow/react';

export type EdgeKind = 'derive' | 'probe' | 'challenge' | 'belong';
const EDGE_KINDS: ReadonlySet<string> = new Set(['derive', 'probe', 'challenge', 'belong']);

export interface NodeSize {
  width: number;
  height: number;
}

export const DEFAULT_ANSWER_SIZE: NodeSize = { width: 720, height: 480 };
export const INTERACTIVE_ASPECT_RATIO = 3 / 2;
export const DEFAULT_INTERACTIVE_SPLIT_RATIO = 0.62;
const INTERACTIVE_RIGHT_SPACE = 254;

export function interactiveNodeSize(width: number, splitRatio = DEFAULT_INTERACTIVE_SPLIT_RATIO): NodeSize {
  const outerRatio = INTERACTIVE_ASPECT_RATIO / splitRatio;
  let nextWidth = Math.max(320, width, INTERACTIVE_RIGHT_SPACE / (1 - splitRatio));
  let nextHeight = nextWidth / outerRatio;
  if (nextHeight < 240) {
    nextHeight = 240;
    nextWidth = nextHeight * outerRatio;
  }
  return { width: Math.round(nextWidth), height: Math.round(nextHeight) };
}

export function interactiveFreeSize(width: number, height: number): NodeSize {
  const nextHeight = Math.max(240, height);
  const minWidth = nextHeight * INTERACTIVE_ASPECT_RATIO + INTERACTIVE_RIGHT_SPACE;
  return { width: Math.round(Math.max(320, width, minWidth)), height: Math.round(nextHeight) };
}

export const DEFAULT_INTERACTIVE_SIZE = interactiveNodeSize(960);

export type SessionTemplate = 'learning' | 'project';

export interface Session {
  id: string;
  title: string;
  template: SessionTemplate;
  createdAt: string;
  updatedAt?: string;
}

export function createSession(): Session {
  return {
    id: crypto.randomUUID(),
    title: '未命名探索',
    template: 'learning',
    createdAt: new Date().toISOString(),
  };
}

export interface Anchor {
  x: number;
  y: number;
}

export interface PdfBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type HighlightKind = 'text' | 'image';

export interface Highlight {
  id: string;
  quote: string;
  textStart?: number | null;
  anchor?: Anchor | null;
  pageNumber?: number;
  kind?: HighlightKind;
  boxes?: PdfBox[];
}

export type NodeRole = 'user' | 'assistant' | 'interactive' | 'reference';
export type NodeType = 'root' | 'question' | 'chat' | 'interactive' | 'reference';
export type CanvasNodeType = 'conversation' | 'interactive' | 'pdf' | 'image';
export type AssetKind = 'pdf' | 'image';
export type ModelInput = 'text' | 'image';

export interface ModelSelection {
  providerId: string;
  modelId: string;
}

export interface UsageCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  totalFromProvider?: boolean;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: UsageCost;
}

export interface GenerationDiagnostic {
  stage: string;
  attempts: number;
  durationMs: number;
  summary: string;
}

export type ReviewStatus = 'reviewed' | 'skipped' | 'failed';

export type ConversationNodeData = {
  nodeType: NodeType;
  role: NodeRole;
  content: string;
  model: ModelSelection | null;
  pending: boolean;
  error: string;
  createdAt: number;
  title?: string;
  fileName?: string;
  fileId?: string;
  assetKind?: AssetKind;
  mimeType?: string | null;
  imageAssetId?: string | null;
  pageCount?: number;
  contextText?: string;
  contextTruncated?: boolean;
  explanation?: string;
  prompt?: string | null;
  usage?: Usage | null;
  reviewing?: boolean;
  reviewAttempt?: number;
  previewContent?: string;
  fallback?: boolean;
  reviewStatus?: ReviewStatus;
  generationDiagnostic?: GenerationDiagnostic | null;
  highlights?: Highlight[];
  autoFocus?: boolean;
};

export type ConversationEdgeData = {
  kind: EdgeKind;
  thinking: string;
  streaming: boolean;
  error: string;
  quote?: string;
  anchor?: Anchor | null;
  highlightId?: string | null;
  checkpoint?: boolean;
  renderLayer?: number;
};

export type ConversationNode = Node<ConversationNodeData, CanvasNodeType>;
export type ConversationEdge = Edge<ConversationEdgeData, 'thinking'> & { data: ConversationEdgeData };

export function canCreateFollowupFrom(node: ConversationNode | null | undefined): boolean {
  if (!node || node.data.pending) return false;
  if (node.data.role === 'reference') return Boolean(node.data.fileId);
  return Boolean(node.data.content.trim());
}

export interface SessionSnapshot {
  session: Session;
  nodes: ConversationNode[];
  edges: ConversationEdge[];
}

export type ExportNodeStatus = 'interrupted' | 'fallback' | 'failed' | 'ready';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numericDimension(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function isModelSelection(value: unknown): value is ModelSelection {
  return isRecord(value) && typeof value.providerId === 'string' && typeof value.modelId === 'string';
}

function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'totalTokens'] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) return false;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      if (value.cost[key] !== undefined && !isFiniteNumber(value.cost[key])) return false;
    }
    if (value.cost.totalFromProvider !== undefined && typeof value.cost.totalFromProvider !== 'boolean') return false;
  }
  return true;
}

function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === 'string' && EDGE_KINDS.has(value);
}

function restoredNodeType(value: unknown): NodeType {
  return value === 'root' || value === 'question' || value === 'chat' || value === 'interactive' ? value : 'chat';
}

export function exportSessionSnapshot(session: Session, nodes: ConversationNode[], edges: ConversationEdge[]) {
  return {
    schemaVersion: 1 as const,
    session: { ...session, updatedAt: new Date().toISOString() },
    nodes: nodes.map(node => {
      const status: ExportNodeStatus = node.data.pending
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
        width: node.measured?.width ?? numericDimension(node.style?.width, 300),
        height: node.measured?.height ?? numericDimension(node.style?.height, 200),
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
  };
}

export function exportSession(session: Session, nodes: ConversationNode[], edges: ConversationEdge[]): string {
  return JSON.stringify(exportSessionSnapshot(session, nodes, edges), null, 2);
}

interface ImportedNode {
  id: string;
  position: Anchor;
  value: Record<string, unknown>;
}

interface ImportedEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  value: Record<string, unknown>;
}

export function importSession(text: string): SessionSnapshot {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== 1 || !value.session || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('不是受支持的 Resprout Session 文件');
  }

  const ids = new Set<string>();
  const importedNodes: ImportedNode[] = [];
  for (const raw of value.nodes) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      throw new Error('节点 ID 或位置无效');
    }
    const position = raw.position;
    if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y) || ids.has(raw.id)) {
      throw new Error('节点 ID 或位置无效');
    }
    ids.add(raw.id);
    importedNodes.push({ id: raw.id, position: { x: position.x, y: position.y }, value: raw });
  }

  const targets = new Set<string>();
  const importedEdges: ImportedEdge[] = [];
  for (const raw of value.edges) {
    if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string'
      || !ids.has(raw.from) || !ids.has(raw.to) || raw.from === raw.to || targets.has(raw.to)) {
      throw new Error('连线无效：每个节点只能有一个主父节点');
    }
    if (!isEdgeKind(raw.kind)) {
      throw new Error('连线无效：每个节点只能有一个主父节点');
    }
    targets.add(raw.to);
    importedEdges.push({ from: raw.from, to: raw.to, kind: raw.kind, value: raw });
  }

  const sessionValue = isRecord(value.session) ? value.session : {};
  return {
    session: {
      id: String(sessionValue.id ?? crypto.randomUUID()),
      title: String(sessionValue.title ?? '未命名探索'),
      template: sessionValue.template === 'project' ? 'project' : 'learning',
      createdAt: String(sessionValue.createdAt ?? new Date().toISOString()),
    },
    nodes: importedNodes.map((imported): ConversationNode => {
      const node = imported.value;
      const role: NodeRole = node.role === 'interactive' ? 'interactive' : node.role === 'assistant' ? 'assistant' : node.role === 'reference' ? 'reference' : 'user';
      const interactive = role === 'interactive';
      const reference = role === 'reference';
      const summary = typeof node.summary === 'string' ? node.summary : '';
      const status = node.status === 'fallback' || node.status === 'failed' || node.status === 'interrupted' ? node.status : null;
      return {
        id: imported.id,
        type: interactive ? 'interactive' : reference ? (node.assetKind === 'image' ? 'image' : 'pdf') : 'conversation',
        position: imported.position,
        style: role === 'assistant' || interactive || reference
          ? {
              width: isFiniteNumber(node.width) ? Math.max(interactive ? 320 : reference ? 360 : 220, node.width) : reference ? 600 : interactive ? DEFAULT_INTERACTIVE_SIZE.width : DEFAULT_ANSWER_SIZE.width,
              height: isFiniteNumber(node.height) ? Math.max(interactive ? 240 : reference ? 320 : 150, node.height) : reference ? 680 : interactive ? DEFAULT_INTERACTIVE_SIZE.height : DEFAULT_ANSWER_SIZE.height,
            }
          : undefined,
        data: {
          nodeType: interactive ? 'interactive' : reference ? 'reference' : restoredNodeType(node.type),
          role,
          title: typeof node.title === 'string' ? node.title : interactive ? '交互解释' : '',
          fileId: reference ? String(node.fileId ?? imported.id) : undefined,
          fileName: reference ? String(node.fileName ?? node.title ?? 'PDF 文档') : undefined,
          assetKind: reference ? (node.assetKind === 'image' ? 'image' : 'pdf') : undefined,
          mimeType: reference ? (typeof node.mimeType === 'string' ? node.mimeType : null) : undefined,
          imageAssetId: node.imageAssetId ? String(node.imageAssetId) : null,
          pageCount: reference && isFiniteNumber(node.pageCount) ? node.pageCount : 0,
          contextText: reference ? String(node.contextText ?? '') : undefined,
          contextTruncated: reference ? Boolean(node.contextTruncated) : false,
          content: String(node.content ?? ''),
          explanation: typeof node.explanation === 'string' ? node.explanation : '',
          prompt: typeof node.prompt === 'string' ? node.prompt : null,
          model: isModelSelection(node.model) ? node.model : null,
          usage: isUsage(node.usage) ? node.usage : null,
          pending: false,
          reviewing: false,
          reviewAttempt: 0,
          previewContent: '',
          fallback: status === 'fallback',
          error: status === 'failed' ? (summary || '此卡片上次生成失败，请重新生成') : status === 'interrupted' ? '生成在会话保存时中断，请重新生成' : '',
          generationDiagnostic: summary ? { stage: 'restored', attempts: 0, durationMs: 0, summary } : null,
          createdAt: isFiniteNumber(node.createdAt) ? node.createdAt : Date.now(),
          highlights: sanitizeHighlights(node.highlights),
        },
      };
    }),
    edges: importedEdges.map((imported): ConversationEdge => {
      const edge = imported.value;
      return {
        id: edge.id != null ? String(edge.id) : crypto.randomUUID(),
        source: imported.from,
        target: imported.to,
        type: 'thinking',
        ...(typeof edge.fromHandle === 'string' && edge.fromHandle ? { sourceHandle: edge.fromHandle } : {}),
        data: {
          kind: imported.kind,
          thinking: String(edge.thinking ?? ''),
          streaming: false,
          error: '',
          quote: String(edge.quote ?? ''),
          anchor: sanitizeAnchor(edge.anchor),
          highlightId: typeof edge.highlight === 'string' && edge.highlight ? edge.highlight : null,
        },
      };
    }),
  };
}

function sanitizeHighlights(value: unknown): Highlight[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> & { quote: string } =>
      isRecord(item) && typeof item.quote === 'string' && Boolean(item.quote.trim()))
    .map(item => ({
      id: String(item.id ?? crypto.randomUUID()),
      quote: item.quote,
      textStart: typeof item.textStart === 'number' && Number.isInteger(item.textStart) ? item.textStart : null,
      anchor: sanitizeAnchor(item.anchor),
      ...(typeof item.pageNumber === 'number' && Number.isInteger(item.pageNumber) && item.pageNumber > 0 ? { pageNumber: item.pageNumber } : {}),
      ...(item.kind === 'image' ? { kind: 'image' as const } : {}),
      ...(Array.isArray(item.boxes) ? { boxes: sanitizePdfBoxes(item.boxes) } : {}),
    }));
}

function sanitizePdfBoxes(value: unknown[]): PdfBox[] {
  const boxes: PdfBox[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { x, y, w, h } = item;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) continue;
    const box = {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      w: Math.max(0, Math.min(1, w)),
      h: Math.max(0, Math.min(1, h)),
    };
    if (box.w > 0 && box.h > 0) boxes.push(box);
  }
  return boxes;
}

function sanitizeAnchor(value: unknown): Anchor | null {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return null;
  return { x: value.x, y: value.y };
}
