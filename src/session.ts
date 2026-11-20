import type { Edge, Node } from '@xyflow/react';
import type { TechnicalStatus } from './interactive-validation.ts';
import { sanitizeInteractiveVerificationSummary } from './interactive-verification.ts';
import type { InteractiveVerificationSummary } from './interactive-verification.ts';

export type EdgeKind = 'derive' | 'probe' | 'challenge' | 'belong';
const EDGE_KINDS: ReadonlySet<string> = new Set(['derive', 'probe', 'challenge', 'belong']);

export interface NodeSize {
  width: number;
  height: number;
}

export const DEFAULT_ANSWER_SIZE: NodeSize = { width: 720, height: 480 };
export const NODE_VERTICAL_GAP = 48;
export const DEFAULT_MULTI_MODEL_SIZE: NodeSize = { width: 260, height: 220 };
export const DEFAULT_MULTI_INTERACTIVE_SIZE: NodeSize = { width: 260, height: 150 };
/**
 * 3:2 指左侧生成内容 iframe 的实际 CSS 内容视口宽高比，
 * 不包含右侧知识说明、分隔条、卡片边框与宿主状态条。
 */
export const INTERACTIVE_ASPECT_RATIO = 3 / 2;
/**
 * 默认分栏占比：左 iframe 占内宽的份额。取值 0.75 使右栏（知识说明）高:宽 = 2:1——
 * frameHeight = frameWidth / 1.5，explanationWidth = frameHeight / 2，栏间距为 0。
 * 分栏比例不再提供拖拽调整（分隔条已移除）；旧存档比例经 interactiveSplitFromSize 保留。
 */
export const DEFAULT_INTERACTIVE_SPLIT_RATIO = 0.75;
const INTERACTIVE_SPLIT_MIN = 0.35;
const INTERACTIVE_SPLIT_MAX = 0.75;
/** 宿主卡片（card-surface）左右/上下边框合计。 */
export const INTERACTIVE_CARD_BORDER = 2;
/** 左 iframe 与右栏之间的间隙（原分隔条占位；分隔条已移除，靠右栏左边线分隔）。 */
export const INTERACTIVE_DIVIDER_WIDTH = 0;
/** 右侧知识说明可读最小宽度。 */
export const INTERACTIVE_MIN_EXPLANATION_WIDTH = 220;
/** 低于该 iframe 视口尺寸时宿主限制继续缩小；布局回归覆盖 480×320 及以上。 */
export const INTERACTIVE_MIN_FRAME_WIDTH = 360;
export const INTERACTIVE_MIN_FRAME_HEIGHT = 240;
/** 运行错误条占位高度；错误条出现时节点高度同步增加，iframe 保持 3:2。 */
export const INTERACTIVE_ERROR_BAR_INSET = 32;

export interface InteractiveViewportPlan {
  nodeWidth: number;
  nodeHeight: number;
  /** iframe 内容视口（CSS 像素），恒定满足 width/height ≈ INTERACTIVE_ASPECT_RATIO。 */
  frameWidth: number;
  frameHeight: number;
  explanationWidth: number;
}

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERACTIVE_SPLIT_RATIO;
  return Math.min(INTERACTIVE_SPLIT_MAX, Math.max(INTERACTIVE_SPLIT_MIN, value));
}

function round1(value: number): number {
  return Math.round(value);
}

/** 由节点外宽推导整张计划：iframe 宽度 = 内容宽 × 占比，高度 = 宽度 × 2/3，节点高度补齐装饰。 */
export function interactiveViewportPlan(nodeWidth: number, splitRatio = DEFAULT_INTERACTIVE_SPLIT_RATIO, topInset = 0): InteractiveViewportPlan {
  const split = clampSplitRatio(splitRatio);
  const inset = Math.max(0, round1(topInset));
  const minNodeWidth = Math.max(
    INTERACTIVE_MIN_FRAME_WIDTH / split,
    (INTERACTIVE_MIN_EXPLANATION_WIDTH + INTERACTIVE_DIVIDER_WIDTH + INTERACTIVE_CARD_BORDER) / (1 - split),
  ) + INTERACTIVE_CARD_BORDER;
  const width = Math.max(320, round1(nodeWidth), round1(minNodeWidth));
  const innerWidth = width - INTERACTIVE_CARD_BORDER;
  const frameWidth = round1(innerWidth * split);
  const frameHeight = Math.max(INTERACTIVE_MIN_FRAME_HEIGHT, round1(frameWidth / INTERACTIVE_ASPECT_RATIO));
  const nodeHeight = frameHeight + INTERACTIVE_CARD_BORDER + inset;
  return {
    nodeWidth: width,
    nodeHeight,
    frameWidth,
    frameHeight,
    explanationWidth: innerWidth - frameWidth - INTERACTIVE_DIVIDER_WIDTH,
  };
}

/** 由目标 iframe 高度反推节点尺寸（角部缩放等“高度驱动”路径）。 */
function interactivePlanFromHeight(nodeHeight: number, splitRatio: number, topInset: number): InteractiveViewportPlan {
  const split = clampSplitRatio(splitRatio);
  const inset = Math.max(0, round1(topInset));
  const frameHeight = Math.max(INTERACTIVE_MIN_FRAME_HEIGHT, round1(nodeHeight - INTERACTIVE_CARD_BORDER - inset));
  const frameWidth = round1(frameHeight * INTERACTIVE_ASPECT_RATIO);
  const innerWidth = frameWidth / split;
  const width = Math.max(
    320,
    round1(innerWidth + INTERACTIVE_CARD_BORDER),
    round1((INTERACTIVE_MIN_EXPLANATION_WIDTH + INTERACTIVE_DIVIDER_WIDTH + INTERACTIVE_CARD_BORDER) / (1 - split) + INTERACTIVE_CARD_BORDER),
  );
  return {
    nodeWidth: width,
    nodeHeight: frameHeight + INTERACTIVE_CARD_BORDER + inset,
    frameWidth,
    frameHeight,
    explanationWidth: round1(width - INTERACTIVE_CARD_BORDER) - frameWidth - INTERACTIVE_DIVIDER_WIDTH,
  };
}

export function interactiveNodeSize(width: number, splitRatio = DEFAULT_INTERACTIVE_SPLIT_RATIO, topInset = 0): NodeSize {
  const plan = interactiveViewportPlan(width, splitRatio, topInset);
  return { width: plan.nodeWidth, height: plan.nodeHeight };
}

/**
 * 角部缩放等自由尺寸路径：宽高两个候选都保持 iframe 3:2 与右栏最小宽度，
 * 选择偏离用户拖动结果较小的方案；分栏比例是缩放不变量，缩放即整体等比变化。
 */
export function interactiveFreeSize(width: number, height: number, topInset = 0): NodeSize {
  const fromHeight = interactivePlanFromHeight(height, DEFAULT_INTERACTIVE_SPLIT_RATIO, topInset);
  const fromWidth = interactiveViewportPlan(width, DEFAULT_INTERACTIVE_SPLIT_RATIO, topInset);
  const heightDrivenOffset = Math.abs(fromHeight.nodeWidth - width);
  const widthDrivenOffset = Math.abs(fromWidth.nodeHeight - height);
  const plan = heightDrivenOffset <= widthDrivenOffset ? fromHeight : fromWidth;
  return { width: plan.nodeWidth, height: plan.nodeHeight };
}

/** 从既有节点尺寸反推分栏占比（挂载、存档恢复、角部缩放时保持用户分配）。 */
export function interactiveSplitFromSize(nodeWidth: number, nodeHeight: number, topInset = 0): number {
  const inset = Math.max(0, round1(topInset));
  const innerWidth = nodeWidth - INTERACTIVE_CARD_BORDER;
  if (innerWidth <= 0) return DEFAULT_INTERACTIVE_SPLIT_RATIO;
  const frameHeight = nodeHeight - INTERACTIVE_CARD_BORDER - inset;
  if (frameHeight <= 0) return DEFAULT_INTERACTIVE_SPLIT_RATIO;
  return clampSplitRatio((frameHeight * INTERACTIVE_ASPECT_RATIO) / innerWidth);
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
export type NodeType = 'root' | 'question' | 'chat' | 'interactive' | 'reference' | 'multi';
export type CanvasNodeType = 'conversation' | 'interactive' | 'pdf' | 'image' | 'multi';
export type AssetKind = 'pdf' | 'image';
export type ModelInput = 'text' | 'image';
export type GenerationRunKind = 'answer' | 'interactive';

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
  technicalStatus?: TechnicalStatus;
  runId?: string;
  candidateHash?: string;
  counters?: {
    modelCalls: number;
    repairs: number;
    checks: number;
  };
}

export type ReviewStatus = 'reviewed' | 'skipped' | 'failed';

export type ConversationNodeData = {
  nodeType: NodeType;
  role: NodeRole;
  content: string;
  model: ModelSelection | null;
  models?: ModelSelection[];
  generationKind?: GenerationRunKind;
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
  /** 正在生成的阶段：generation → experiment → check；仅进行中显示。 */
  phase?: 'generation' | 'experiment' | 'check';
  previewContent?: string;
  fallback?: boolean;
  reviewStatus?: ReviewStatus;
  verificationSummary?: InteractiveVerificationSummary;
  generationDiagnostic?: GenerationDiagnostic | null;
  technicalStatus?: TechnicalStatus;
  recoveryStatus?: 'verified' | 'unverified' | 'rejected';
  reviewAdvisories?: string[];
  issueCodes?: string[];
  cancelled?: boolean;
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

export function multiModelGenerationKind(data: Pick<ConversationNodeData, 'content' | 'generationKind'>): GenerationRunKind {
  return data.generationKind ?? (data.content.trim() ? 'answer' : 'interactive');
}

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

export type ExportNodeStatus = 'interrupted' | 'fallback' | 'failed' | 'unverified' | 'ready';

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
  return value === 'root' || value === 'question' || value === 'chat' || value === 'interactive' || value === 'multi' ? value : 'chat';
}

function restoredModelSelections(value: unknown): ModelSelection[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isModelSelection);
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
            : node.data.technicalStatus && node.data.technicalStatus !== 'pass'
              ? 'unverified'
              : 'ready';
      return {
        id: node.id,
        type: node.data.nodeType,
        role: node.data.role ?? 'user',
        status,
        summary: node.data.generationDiagnostic?.summary ?? '',
        technicalStatus: node.data.technicalStatus ?? null,
        recoveryStatus: node.data.recoveryStatus ?? null,
        reviewStatus: node.data.reviewStatus ?? null,
        verificationSummary: node.data.verificationSummary ?? null,
        reviewAdvisories: node.data.reviewAdvisories ?? [],
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
        models: node.data.models ?? [],
        ...(node.data.nodeType === 'multi' ? { generationKind: multiModelGenerationKind(node.data) } : {}),
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
      const multi = role === 'user' && node.type === 'multi';
      const content = String(node.content ?? '');
      const generationKind: GenerationRunKind | undefined = multi
        ? node.generationKind === 'answer' || node.generationKind === 'interactive'
          ? node.generationKind
          : content.trim() ? 'answer' : 'interactive'
        : undefined;
      const summary = typeof node.summary === 'string' ? node.summary : '';
      const status = node.status === 'fallback' || node.status === 'failed' || node.status === 'interrupted' || node.status === 'unverified'
        ? node.status
        : null;
      const technicalStatus: TechnicalStatus | undefined = node.technicalStatus === 'pass' || node.technicalStatus === 'fail' || node.technicalStatus === 'inconclusive'
        ? node.technicalStatus
        : status === 'unverified' ? 'inconclusive' : undefined;
      const recoveryStatus = node.recoveryStatus === 'verified' || node.recoveryStatus === 'unverified' || node.recoveryStatus === 'rejected'
        ? node.recoveryStatus
        : undefined;
      const reviewStatus: ReviewStatus | undefined = node.reviewStatus === 'reviewed' || node.reviewStatus === 'skipped' || node.reviewStatus === 'failed'
        ? node.reviewStatus
        : undefined;
      const reviewAdvisories = Array.isArray(node.reviewAdvisories)
        ? node.reviewAdvisories.filter((item): item is string => typeof item === 'string').slice(0, 20)
        : [];
      const verificationSummary = sanitizeInteractiveVerificationSummary(node.verificationSummary);
      return {
        id: imported.id,
        type: interactive ? 'interactive' : reference ? (node.assetKind === 'image' ? 'image' : 'pdf') : multi ? 'multi' : 'conversation',
        position: imported.position,
        style: role === 'assistant' || interactive || reference || multi
          ? {
              width: isFiniteNumber(node.width) ? Math.max(interactive ? 320 : reference ? 360 : multi ? 260 : 220, node.width) : reference ? 600 : interactive ? DEFAULT_INTERACTIVE_SIZE.width : multi ? DEFAULT_MULTI_MODEL_SIZE.width : DEFAULT_ANSWER_SIZE.width,
              height: isFiniteNumber(node.height) ? Math.max(interactive ? 240 : reference ? 320 : 150, node.height) : reference ? 680 : interactive ? DEFAULT_INTERACTIVE_SIZE.height : multi ? (generationKind === 'interactive' ? DEFAULT_MULTI_INTERACTIVE_SIZE.height : DEFAULT_MULTI_MODEL_SIZE.height) : DEFAULT_ANSWER_SIZE.height,
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
          content,
          explanation: typeof node.explanation === 'string' ? node.explanation : '',
          prompt: typeof node.prompt === 'string' ? node.prompt : null,
          model: isModelSelection(node.model) ? node.model : null,
          models: multi ? restoredModelSelections(node.models) : undefined,
          generationKind,
          usage: isUsage(node.usage) ? node.usage : null,
          pending: false,
          phase: undefined,
          previewContent: '',
          fallback: status === 'fallback',
          // 问题节点本身不会生成失败；旧存档可能把回答的失败记在问题上，恢复时不还原该横幅。
          error: status === 'failed' && role !== 'user' ? (summary || '此卡片上次生成失败，请重新生成') : status === 'interrupted' ? '生成在会话保存时中断，请重新生成' : '',
          generationDiagnostic: summary ? { stage: 'restored', attempts: 0, durationMs: 0, summary, ...(technicalStatus ? { technicalStatus } : {}) } : null,
          technicalStatus,
          recoveryStatus,
          reviewStatus,
          verificationSummary,
          reviewAdvisories,
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
