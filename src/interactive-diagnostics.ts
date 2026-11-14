/**
 * 生成运行的诊断记录：run/candidate/check 身份、阶段耗时、模型调用用途与 usage、
 * 截断标记、一次修复记录、readiness 检查结论。
 *
 * 默认不打印完整原始对话；导出是显式动作，带大小上限、截断标记和凭证脱敏。
 * 诊断包包含用户材料，UI 文案必须提示这一点。
 *
 * 生产主流程只有三个阶段：generation → check（readiness）→ 至多一次 repair → check。
 * 诊断包 v2 移除 plan/review/advisories/validations 字段；旧 v1 包仍可由
 * `--replay` 读取（候选内容 + validations 状态），不被本模块改动。
 */

import { hashText } from './interactive-html.ts';

export const DIAGNOSTIC_BUNDLE_VERSION = 2;
export const DIAGNOSTIC_BUNDLE_MAX_BYTES = 1_500_000;

export interface DiagnosticModelRef {
  providerId: string;
  modelId: string;
}

export interface DiagnosticStageRecord {
  stage: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'failed' | 'cancelled';
  summary: string;
}

export interface DiagnosticUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  totalTokens?: number;
}

export interface DiagnosticCallRecord {
  purpose: string;
  startedAt: number;
  durationMs: number;
  usage: DiagnosticUsage | null;
  stopReason: string;
  truncated: boolean;
}

export type DiagnosticCandidateSource = 'initial' | 'repair';

export interface DiagnosticCandidateRecord {
  candidateId: string;
  contentHash: string;
  source: DiagnosticCandidateSource;
  createdAt: number;
  content: string;
  /** 规范化前的原始模型输出（供定位规范化问题）。 */
  rawContent: string | null;
  checkIds: string[];
  readiness: string | null;
}

export interface DiagnosticCheckRecord {
  checkId: string;
  candidateHash: string;
  status: 'ready' | 'failed' | 'unavailable' | 'cancelled';
  reason: string;
  durationMs: number;
}

export interface DiagnosticRepairRecord {
  attempt: number;
  summary: string;
  applied: boolean;
  code: string;
}

export interface InteractiveRunCounters {
  modelCalls: number;
  repairs: number;
  checks: number;
}

export interface DiagnosticBundle {
  version: number;
  runId: string;
  createdAt: number;
  runtimeVersion: string;
  model: DiagnosticModelRef | null;
  stages: DiagnosticStageRecord[];
  calls: DiagnosticCallRecord[];
  candidates: DiagnosticCandidateRecord[];
  checks: DiagnosticCheckRecord[];
  repairs: DiagnosticRepairRecord[];
  counters: InteractiveRunCounters;
  truncated: boolean;
  omittedCandidates: number;
  redacted: boolean;
}

export interface DiagnosticExportOptions {
  maxBytes?: number;
  includeContent?: boolean;
}

export interface DiagnosticExportResult {
  json: string;
  bytes: number;
  truncated: boolean;
  omittedCandidates: number;
}

function byteLength(value: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(value).length : value.length;
}

function emptyCounters(): InteractiveRunCounters {
  return { modelCalls: 0, repairs: 0, checks: 0 };
}

function usageFrom(value: unknown): DiagnosticUsage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const usage: DiagnosticUsage = {};
  for (const key of ['input', 'output', 'reasoning', 'totalTokens'] as const) {
    if (typeof record[key] === 'number' && Number.isFinite(record[key])) usage[key] = record[key] as number;
  }
  return Object.keys(usage).length ? usage : null;
}

const SECRET_PATTERN = /\b(?:sk|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi;
const API_KEY_PATTERN = /("(?:api[_-]?key|authorization|secret)"\s*:\s*")[^"]*(")/gi;

export function redactDiagnosticText(value: string): string {
  return value.replace(SECRET_PATTERN, '[redacted]').replace(API_KEY_PATTERN, '$1[redacted]$2');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = redactValue(item);
    return result;
  }
  return value;
}

/**
 * 一次运行一份记录器。候选 HTML 只保留当前运行产生的内容，不累积历史提示词。
 * 模型调用预算：正常 1 次，至多 2 次（一次修复）；截断续写不再作为独立阶段。
 */
export class InteractiveDiagnosticsRecorder {
  readonly runId: string;
  readonly createdAt: number;
  readonly runtimeVersion: string;
  readonly model: DiagnosticModelRef | null;
  private readonly stages: DiagnosticStageRecord[] = [];
  private readonly calls: DiagnosticCallRecord[] = [];
  private readonly candidates: DiagnosticCandidateRecord[] = [];
  private readonly checks: DiagnosticCheckRecord[] = [];
  private readonly repairs: DiagnosticRepairRecord[] = [];
  private counters: InteractiveRunCounters = emptyCounters();

  constructor(input: { runId: string; runtimeVersion: string; model?: DiagnosticModelRef | null; createdAt?: number }) {
    this.runId = input.runId;
    this.createdAt = input.createdAt ?? Date.now();
    this.runtimeVersion = input.runtimeVersion;
    this.model = input.model ?? null;
  }

  recordStage(stage: string, startedAt: number, status: 'ok' | 'failed' | 'cancelled', summary = ''): void {
    this.stages.push({
      stage,
      startedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      status,
      summary: summary.slice(0, 400),
    });
  }

  recordCall(input: {
    purpose: string;
    startedAt: number;
    usage?: unknown;
    stopReason?: string;
    truncated?: boolean;
  }): void {
    this.calls.push({
      purpose: input.purpose,
      startedAt: input.startedAt,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      usage: usageFrom(input.usage),
      stopReason: (input.stopReason ?? '').slice(0, 80),
      truncated: input.truncated === true,
    });
  }

  recordCandidate(input: {
    candidateId: string;
    content: string;
    rawContent?: string | null;
    source: DiagnosticCandidateSource;
    createdAt?: number;
  }): void {
    this.candidates.push({
      candidateId: input.candidateId,
      contentHash: hashText(input.content),
      source: input.source,
      createdAt: input.createdAt ?? Date.now(),
      content: input.content,
      rawContent: input.rawContent ?? null,
      checkIds: [],
      readiness: null,
    });
  }

  recordCheck(input: {
    checkId: string;
    candidateHash: string;
    candidateId: string;
    status: 'ready' | 'failed' | 'unavailable' | 'cancelled';
    reason: string;
    durationMs: number;
  }): void {
    this.checks.push({
      checkId: input.checkId,
      candidateHash: input.candidateHash,
      status: input.status,
      reason: input.reason.slice(0, 400),
      durationMs: input.durationMs,
    });
    const candidate = this.candidates.find(item => item.candidateId === input.candidateId);
    if (candidate) {
      if (!candidate.checkIds.includes(input.checkId)) candidate.checkIds.push(input.checkId);
      candidate.readiness = input.status;
    }
  }

  recordRepair(input: DiagnosticRepairRecord): void {
    this.repairs.push(input);
  }

  setCounters(counters: InteractiveRunCounters): void {
    this.counters = { ...counters };
  }

  toBundle(options: DiagnosticExportOptions = {}): DiagnosticExportResult {
    const limit = Math.max(10_000, options.maxBytes ?? DIAGNOSTIC_BUNDLE_MAX_BYTES);
    const includeContent = options.includeContent !== false;
    let candidates = this.candidates.map(candidate => ({
      ...candidate,
      content: includeContent ? candidate.content : '',
      rawContent: includeContent ? candidate.rawContent : null,
    }));
    let omittedCandidates = 0;
    const serialize = (): DiagnosticBundle => redactValue({
      version: DIAGNOSTIC_BUNDLE_VERSION,
      runId: this.runId,
      createdAt: this.createdAt,
      runtimeVersion: this.runtimeVersion,
      model: this.model,
      stages: this.stages,
      calls: this.calls,
      candidates,
      checks: this.checks,
      repairs: this.repairs,
      counters: this.counters,
      truncated: omittedCandidates > 0,
      omittedCandidates,
      redacted: true,
    }) as DiagnosticBundle;
    let bundle = serialize();
    let json = JSON.stringify(bundle, null, 2);
    while (byteLength(json) > limit && candidates.some(candidate => candidate.content || candidate.rawContent)) {
      const index = candidates.findIndex(candidate => candidate.content || candidate.rawContent);
      const removed = candidates[index];
      if (removed) {
        candidates[index] = { ...removed, content: '', rawContent: null };
      }
      omittedCandidates += 1;
      bundle = serialize();
      json = JSON.stringify(bundle, null, 2);
    }
    return {
      json,
      bytes: byteLength(json),
      truncated: bundle.truncated,
      omittedCandidates: bundle.omittedCandidates,
    };
  }
}

/**
 * 运行期间只保留有限数量的诊断包，避免长期占用内存；导出按需读取。
 */
export class DiagnosticBundleStore {
  private readonly bundles = new Map<string, InteractiveDiagnosticsRecorder>();
  private readonly limit: number;

  constructor(limit = 24) {
    this.limit = Math.max(1, limit);
  }

  set(key: string, recorder: InteractiveDiagnosticsRecorder): void {
    this.bundles.delete(key);
    this.bundles.set(key, recorder);
    while (this.bundles.size > this.limit) {
      const oldest = this.bundles.keys().next().value;
      if (oldest === undefined) break;
      this.bundles.delete(oldest);
    }
  }

  get(key: string): InteractiveDiagnosticsRecorder | undefined {
    return this.bundles.get(key);
  }

  delete(key: string): void {
    this.bundles.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of [...this.bundles.keys()]) {
      if (key.startsWith(prefix)) this.bundles.delete(key);
    }
  }

  export(key: string, options?: DiagnosticExportOptions): DiagnosticExportResult | null {
    return this.bundles.get(key)?.toBundle(options) ?? null;
  }

  clear(): void {
    this.bundles.clear();
  }
}
