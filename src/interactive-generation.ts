import { streamChat } from './api.ts';
import type { ChatModelRef, ChatOptions, ChatUsage } from './api.ts';
import {
  fallbackExplanation,
  focusedSelectionText,
  readinessToTechnicalStatus,
  sourceText,
  topicFor,
} from './interactive-context.ts';
import type { InteractiveMessage } from './interactive-context.ts';
import { InteractiveDiagnosticsRecorder } from './interactive-diagnostics.ts';
import type { InteractiveRunCounters } from './interactive-diagnostics.ts';
import { hashText } from './interactive-html.ts';
import { parseInteractiveGenerationOutput } from './interactive-json.ts';
import {
  checkInteractiveReadiness,
  INTERACTIVE_RUNTIME_VERSION,
} from './interactive-runtime.ts';
import type { InteractiveReadinessResult } from './interactive-runtime.ts';
import { makeIssue } from './interactive-validation.ts';
import type { InteractiveIssue, TechnicalStatus } from './interactive-validation.ts';
import { sanitizeInteractiveVerificationSummary } from './interactive-verification.ts';
import type { InteractiveVerificationSummary } from './interactive-verification.ts';
import interactiveLearningStandard from './prompts/interactive-learning.md?raw';

export {
  fallbackExplanation,
  focusedSelectionText,
  parseInteractiveGenerationOutput,
  readinessToTechnicalStatus,
  sourceText,
  topicFor,
};
export type { InteractiveMessage };

const OUTPUT_TRUNCATED_CODE = 'INTERACTIVE_OUTPUT_TRUNCATED';
export const INTERACTIVE_ABORTED_CODE = 'INTERACTIVE_ABORTED';

export type InteractiveStage =
  | 'generation'
  | 'experiment'
  | 'check'
  | 'provider'
  | 'protocol'
  | 'done'
  | 'cancelled';
export type InteractiveDiagnosticStage = InteractiveStage | (string & {});
export type InteractiveReviewStatus = 'reviewed' | 'skipped' | 'failed';

export interface InteractiveDiagnostic {
  stage: InteractiveDiagnosticStage;
  attempts: number;
  summary: string;
  durationMs: number;
  technicalStatus?: TechnicalStatus;
  runId?: string;
  candidateHash?: string;
  counters?: InteractiveRunCounters;
}

export interface GeneratedInteractiveResult {
  content: string;
  fallback: false;
  /** Agent 自检不是独立教学审核。 */
  reviewStatus: 'skipped';
  explanation: string;
  verificationSummary: InteractiveVerificationSummary;
  diagnostic: InteractiveDiagnostic;
  technicalStatus: 'pass';
  readiness: 'ready';
  runId: string;
  counters: InteractiveRunCounters;
}

export interface FallbackInteractiveResult {
  content: '';
  fallback: true;
  reviewStatus: 'failed';
  explanation: string;
  diagnostic: InteractiveDiagnostic;
  technicalStatus: TechnicalStatus;
  issues: InteractiveIssue[];
  runId: string;
  counters: InteractiveRunCounters;
}

export type InteractiveResult = GeneratedInteractiveResult | FallbackInteractiveResult;
export type InteractiveProgressPhase = 'generation' | 'experiment' | 'check';

export interface InteractiveProgress {
  phase: InteractiveProgressPhase;
}

export interface RequestInteractiveHtmlOptions {
  onDelta?: ((output: string) => void) | undefined;
  onProgress?: ((progress: InteractiveProgress) => void) | undefined;
  onDiagnostics?: ((recorder: InteractiveDiagnosticsRecorder) => void) | undefined;
  signal?: AbortSignal | undefined;
}

const INTERACTIVE_STAGES: ReadonlySet<string> = new Set([
  'generation',
  'experiment',
  'check',
  'provider',
  'protocol',
  'done',
  'cancelled',
]);

function isInteractiveStage(value: unknown): value is InteractiveStage {
  return typeof value === 'string' && INTERACTIVE_STAGES.has(value);
}

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function createInteractiveError(
  message: string,
  properties: { code?: string; stage?: InteractiveStage } = {},
): Error {
  return Object.assign(new Error(message), properties);
}

function stageOf(error: unknown): InteractiveStage | undefined {
  const stage = recordValue(error, 'stage');
  return isInteractiveStage(stage) ? stage : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = recordValue(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

export function isInteractiveAbortError(error: unknown): boolean {
  return errorCode(error) === INTERACTIVE_ABORTED_CODE;
}

export function isInteractiveAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (isInteractiveAbortError(error)) return true;
  return signal?.aborted === true;
}

export function interactiveAbortError(): Error {
  return createInteractiveError('交互生成已取消', { code: INTERACTIVE_ABORTED_CODE, stage: 'cancelled' });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw interactiveAbortError();
}

export function buildInteractiveInstruction(topic: string): string {
  return `请把上述对话涉及的核心内容制作成一个交互解释页面${topic ? `，重点是“${topic}”` : ''}。\n\n${interactiveLearningStandard}`;
}

interface CallContext {
  diagnostics: InteractiveDiagnosticsRecorder;
  signal?: AbortSignal | undefined;
  onTool?: ((name: string) => void) | undefined;
}

async function requestAgent(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  onDelta: ((output: string) => void) | null,
  options: ChatOptions,
  call: CallContext,
): Promise<string> {
  throwIfAborted(call.signal);
  const startedAt = Date.now();
  let output = '';
  let stopReason = '';
  let usage: ChatUsage | null = null;
  try {
    try {
      await streamChat(messages, event => {
        if (event.type === 'tool_call') {
          if (event.agentTrace !== undefined) call.diagnostics.recordAgentTrace(event.agentTrace);
          call.onTool?.(event.name);
        }
        if (event.type === 'done') {
          stopReason = event.stopReason ?? '';
          usage = event.usage ?? null;
        }
        if (event.type !== 'text_delta') return;
        output += event.delta;
        onDelta?.(output);
      }, model, options, call.signal);
    } catch (error) {
      call.diagnostics.recordAgentTrace(recordValue(error, 'agentTrace'));
      if (isInteractiveAbortLike(error, call.signal)) throw interactiveAbortError();
      throw error;
    }
    throwIfAborted(call.signal);
    if (stopReason === 'length') throw createInteractiveError('模型输出达到 token 上限，agent 未完成提交', { code: OUTPUT_TRUNCATED_CODE, stage: 'generation' });
    return output;
  } finally {
    call.diagnostics.recordCall({
      purpose: 'interactive-agent',
      startedAt,
      usage,
      stopReason,
      truncated: stopReason === 'length',
    });
  }
}

function readableError(error: unknown): string {
  const text = String(recordValue(error, 'message') ?? error ?? '未知错误').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      const detail = recordValue(value, 'message')
        ?? recordValue(recordValue(value, 'error'), 'message')
        ?? recordValue(value, 'error');
      if (typeof detail === 'string') return `${text.slice(0, start).trim()} ${detail}`.trim().slice(0, 240);
    } catch {
      // Keep the readable prefix when an error contains incomplete JSON.
    }
  }
  return text.slice(0, 240);
}

function makeDiagnostic(
  stage: InteractiveStage,
  attempts: number,
  startedAt: number,
  summary = '',
  extra: Partial<InteractiveDiagnostic> = {},
): InteractiveDiagnostic {
  return { stage, attempts, summary, durationMs: Date.now() - startedAt, ...extra };
}

export function fallbackInteractiveResult(
  messages: readonly InteractiveMessage[],
  topic: string | undefined,
  diagnostic: InteractiveDiagnostic,
  extra: { technicalStatus?: TechnicalStatus; issues?: InteractiveIssue[]; runId?: string; counters?: InteractiveRunCounters } = {},
): FallbackInteractiveResult {
  return {
    content: '',
    fallback: true,
    reviewStatus: 'failed',
    explanation: fallbackExplanation(messages, topic, interactiveLearningStandard),
    diagnostic,
    technicalStatus: extra.technicalStatus ?? 'fail',
    issues: extra.issues ?? [],
    runId: extra.runId ?? '',
    counters: extra.counters ?? { modelCalls: 0, repairs: 0, checks: 0 },
  };
}

function newCandidateId(): string {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `candidate:${random}`;
}

function parseAgentResult(rawOutput: string): { html: string; explanation: string; verificationSummary: InteractiveVerificationSummary; agentTrace: Record<string, unknown> } {
  let envelope: unknown;
  try { envelope = JSON.parse(rawOutput); } catch { /* Reported as a protocol error below. */ }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw createInteractiveError('制作 agent 没有返回结构化产物', { code: 'output-invalid', stage: 'protocol' });
  }
  const record = envelope as Record<string, unknown>;
  if (record.submitted !== true || typeof record.agentTrace !== 'object' || record.agentTrace === null || Array.isArray(record.agentTrace)) {
    throw createInteractiveError('制作 agent 未提交作品及验证记录', { code: 'output-invalid', stage: 'protocol' });
  }
  const parsed = parseInteractiveGenerationOutput(JSON.stringify({ html: record.html, explanation: record.explanation }), 'generation');
  if (!parsed.ok) throw createInteractiveError(parsed.message, { code: parsed.code, stage: 'protocol' });
  const verificationSummary = sanitizeInteractiveVerificationSummary(record.verificationSummary);
  if (!verificationSummary) {
    throw createInteractiveError('制作 agent 的验证摘要无效', { code: 'output-invalid', stage: 'protocol' });
  }
  const contentHash = hashText(parsed.html);
  if (verificationSummary.contentHash !== contentHash || recordValue(record.agentTrace, 'contentHash') !== contentHash) {
    throw createInteractiveError('作品内容哈希与验证证据不匹配', { code: 'stale-evidence', stage: 'protocol' });
  }
  return { html: parsed.html, explanation: parsed.explanation, verificationSummary, agentTrace: record.agentTrace as Record<string, unknown> };
}

/** Agent 制作与实验结束后，只做一次现有轻量运行检查；不再启动旧修复流程。 */
export async function requestInteractiveHtml(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  { onDelta, onProgress, onDiagnostics, signal }: RequestInteractiveHtmlOptions = {},
): Promise<InteractiveResult> {
  const startedAt = Date.now();
  const topic = topicFor(messages);
  const runId = `interactive:${typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const diagnostics = new InteractiveDiagnosticsRecorder({
    runId,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    model: model ? { providerId: model.providerId ?? '', modelId: model.modelId ?? '' } : null,
  });
  const counters: InteractiveRunCounters = { modelCalls: 1, repairs: 0, checks: 0 };
  const progress = (phase: InteractiveProgressPhase): void => onProgress?.({ phase });

  const finalizeFailure = (
    stage: InteractiveStage,
    message: string,
    technicalStatus: TechnicalStatus,
    issues: InteractiveIssue[],
    summaryPrefix: string,
  ): FallbackInteractiveResult => {
    const summary = [summaryPrefix, message && message !== summaryPrefix ? `首因：${message}` : ''].filter(Boolean).join('；').slice(0, 400);
    return fallbackInteractiveResult(messages, topic, makeDiagnostic(stage, counters.modelCalls, startedAt, summary, {
      technicalStatus,
      runId,
      counters: { ...counters },
    }), { technicalStatus, issues, runId, counters: { ...counters } });
  };

  try {
    progress('generation');
    const generationStarted = Date.now();
    const rawOutput = await requestAgent(messages, model, onDelta ?? null, { purpose: 'interactive' }, {
      diagnostics,
      signal,
      onTool: name => {
        if (name === 'preview' || name === 'act') progress('experiment');
        else if (name === 'write_artifact') progress('generation');
      },
    });
    diagnostics.recordStage('generation', generationStarted, 'ok', '制作 agent 已返回结构化产物');
    const parsed = parseAgentResult(rawOutput);
    diagnostics.recordAgentTrace(parsed.agentTrace);
    const turns = Number(parsed.agentTrace.modelTurns);
    if (Number.isFinite(turns) && turns > 0) counters.modelCalls = Math.floor(turns);
    const candidateId = newCandidateId();
    const candidateHash = hashText(parsed.html);
    diagnostics.recordCandidate({ candidateId, content: parsed.html, rawContent: JSON.stringify({ html: parsed.html, explanation: parsed.explanation }), source: 'agent' });

    progress('check');
    counters.checks += 1;
    const checkStarted = Date.now();
    const check: InteractiveReadinessResult = await checkInteractiveReadiness(parsed.html, {
      signal,
      runId,
      candidateId,
      checkId: `${runId}:check:${counters.checks}`,
      candidateHash,
    });
    if (signal?.aborted || check.status === 'cancelled') throw interactiveAbortError();
    diagnostics.recordCheck({ checkId: check.checkId, candidateHash, candidateId, status: check.status, reason: check.reason, durationMs: check.durationMs });
    diagnostics.recordStage('check', checkStarted, check.status === 'ready' ? 'ok' : 'failed', check.status);
    if (check.status !== 'ready') {
      const unavailable = check.status === 'unavailable';
      const issue = check.issue ?? makeIssue(unavailable ? 'check-unavailable' : 'check-failed', unavailable ? 'protocol' : 'runtime', 'blocking', check.reason || '页面没有通过运行检查');
      return finalizeFailure(
        'check',
        issue.message,
        readinessToTechnicalStatus(check.status),
        [issue],
        unavailable ? '页面加载或检查环境失败，未修改 HTML' : '制作 agent 已结束，展示环境检查失败；未启动第二个修复循环',
      );
    }

    const explanation = parsed.explanation || fallbackExplanation(messages, topic, interactiveLearningStandard);
    diagnostics.recordStage('publish', Date.now(), 'ok', '发布 agent 作品与验证摘要；不标记为独立审核通过');
    return {
      content: parsed.html,
      fallback: false,
      reviewStatus: 'skipped',
      explanation,
      verificationSummary: parsed.verificationSummary,
      technicalStatus: 'pass',
      readiness: 'ready',
      runId,
      counters: { ...counters },
      diagnostic: makeDiagnostic('done', counters.modelCalls, startedAt, [
        '制作 agent 已提交视觉与语义自查并通过运行检查',
        parsed.verificationSummary.unverified.length ? `${parsed.verificationSummary.unverified.length} 项判断或状态仍未确认` : '',
        !parsed.explanation ? '知识说明缺失，已使用来源摘要降级' : '',
      ].filter(Boolean).join('；'), { technicalStatus: 'pass', runId, candidateHash, counters: { ...counters } }),
    };
  } catch (error) {
    diagnostics.recordAgentTrace(recordValue(error, 'agentTrace'));
    if (isInteractiveAbortError(error) || signal?.aborted) throw interactiveAbortError();
    const code = errorCode(error);
    const stage = stageOf(error) ?? 'provider';
    return finalizeFailure(
      stage,
      readableError(error),
      stage === 'check' ? 'fail' : 'inconclusive',
      [makeIssue(code || 'provider-failure', stage === 'protocol' ? 'protocol' : 'provider', 'blocking', readableError(error))],
      stage === 'protocol' ? 'agent 产物协议无效，未启动修复流程' : '制作 agent 未完成，未发布候选',
    );
  } finally {
    diagnostics.setCounters({ ...counters });
    try { onDiagnostics?.(diagnostics); } catch { /* Diagnostics must not change generation outcome. */ }
  }
}
