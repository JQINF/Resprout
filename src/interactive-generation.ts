/**
 * 交互卡片生产主流程（一次性生成 + 轻量运行检查 + 至多一次完整修复）。
 *
 * 直线控制流：generate → check → optional repair → check → finish。
 * 正常路径恰好一次模型调用；修复路径最多两次。没有默认设计调用、独立教学审核、
 * 单独知识说明调用、截断续写、多轮 patch/rewrite 或完整验收重试。
 *
 * 生产检查只保证有限窗口内页面能够运行和显示（`checkInteractiveReadiness`），
 * 不证明所有交互或教学内容正确；ready 不被标记为教学审核通过。
 * 确定的脚本错误、空白主体、非法导航仍阻断；环境/加载/协议失败明确报告，
 * 不盲改 HTML。
 */

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
import { GENERATION_OUTPUT_SCHEMA, parseInteractiveGenerationOutput } from './interactive-json.ts';
import {
  checkInteractiveReadiness,
  INTERACTIVE_RUNTIME_VERSION,
} from './interactive-runtime.ts';
import type { InteractiveReadinessResult } from './interactive-runtime.ts';
import { makeIssue } from './interactive-validation.ts';
import type { InteractiveIssue, TechnicalStatus } from './interactive-validation.ts';
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
  | 'check'
  | 'repair'
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
  /** 新流程默认不执行独立教学审核，记录为 skipped；历史 reviewed 保持原含义。 */
  reviewStatus: 'skipped';
  explanation: string;
  diagnostic: InteractiveDiagnostic;
  technicalStatus: 'pass';
  readiness: 'ready';
  runId: string;
  counters: InteractiveRunCounters;
  repaired: boolean;
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

export type InteractiveProgressPhase = 'generation' | 'check' | 'repair';

export interface InteractiveProgress {
  phase: InteractiveProgressPhase;
}

export interface RequestInteractiveHtmlOptions {
  onDelta?: ((output: string) => void) | undefined;
  onProgress?: ((progress: InteractiveProgress) => void) | undefined;
  onDiagnostics?: ((recorder: InteractiveDiagnosticsRecorder) => void) | undefined;
  signal?: AbortSignal | undefined;
}

interface InteractiveFailure {
  stage: 'generation' | 'check' | 'repair' | 'provider' | 'protocol';
  code: string;
  message: string;
  details: string;
}

const INTERACTIVE_STAGES: ReadonlySet<string> = new Set([
  'generation',
  'check',
  'repair',
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
  properties: { code?: string; stage?: InteractiveStage; output?: string } = {},
): Error {
  return Object.assign(new Error(message), properties);
}

function stampStage(error: unknown, stage: InteractiveStage): unknown {
  if (typeof error === 'object' && error !== null) {
    (error as { stage?: InteractiveStage }).stage = stage;
    return error;
  }
  return createInteractiveError(String(error), { stage });
}

function stageOf(error: unknown): InteractiveStage | undefined {
  const stage = recordValue(error, 'stage');
  return isInteractiveStage(stage) ? stage : undefined;
}

function errorCode(error: unknown): string | undefined {
  const code = recordValue(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function isOutputTruncatedError(error: unknown): boolean {
  const output = recordValue(error, 'output');
  return errorCode(error) === OUTPUT_TRUNCATED_CODE && typeof output === 'string' && output.length > 0;
}

export function isInteractiveAbortError(error: unknown): boolean {
  return errorCode(error) === INTERACTIVE_ABORTED_CODE;
}

/** fetch/streamChat 在取消时抛出 DOMException('AbortError')，必须与自定义取消统一处理。 */
export function isInteractiveAbortLike(error: unknown, signal?: AbortSignal): boolean {
  // 只把“用户/宿主取消”当成取消；没有 signal 依据的 AbortError 仍按供应商错误处理。
  if (isInteractiveAbortError(error)) return true;
  return signal?.aborted === true;
}

export function interactiveAbortError(): Error {
  return abortError();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createInteractiveError('交互生成已取消', { code: INTERACTIVE_ABORTED_CODE, stage: 'cancelled' });
}

function abortError(): Error {
  return createInteractiveError('交互生成已取消', { code: INTERACTIVE_ABORTED_CODE, stage: 'cancelled' });
}

export function buildInteractiveInstruction(topic: string): string {
  return `请把上述对话涉及的核心内容制作成一个交互解释页面${topic ? `，重点是“${topic}”` : ''}。\n\n${interactiveLearningStandard}`;
}

interface CallContext {
  purpose: string;
  diagnostics: InteractiveDiagnosticsRecorder;
  signal?: AbortSignal | undefined;
}

async function requestText(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  onDelta: ((output: string) => void) | null = null,
  options: ChatOptions = {},
  call?: CallContext | null,
): Promise<string> {
  throwIfAborted(call?.signal);
  const startedAt = Date.now();
  let output = '';
  let stopReason = '';
  let usage: ChatUsage | null = null;
  try {
    try {
      await streamChat(messages, event => {
        if (event.type === 'done') {
          stopReason = event.stopReason ?? '';
          usage = event.usage ?? null;
        }
        if (event.type !== 'text_delta') return;
        output += event.delta;
        onDelta?.(output);
      }, model, options, call?.signal);
    } catch (error) {
      if (isInteractiveAbortLike(error, call?.signal)) throw abortError();
      throw error;
    }
    throwIfAborted(call?.signal);
    if (stopReason === 'length') {
      // 截断续写已取消：截断属于确定的生成输出错误，走唯一一次修复机会。
      throw createInteractiveError('模型输出达到 token 上限，页面内容被截断', {
        code: OUTPUT_TRUNCATED_CODE,
        output,
      });
    }
    return output;
  } finally {
    if (call) {
      call.diagnostics.recordCall({
        purpose: call.purpose,
        startedAt,
        usage,
        stopReason,
        truncated: stopReason === 'length',
      });
    }
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
      // JSON 片段不完整时退回原始错误文本
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
  return {
    stage,
    attempts,
    summary,
    durationMs: Date.now() - startedAt,
    ...extra,
  };
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

async function requestGeneration(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  onDelta: ((output: string) => void) | undefined,
  call: CallContext,
): Promise<string> {
  return requestText(messages, model, onDelta ?? null, {
    purpose: 'interactive',
    structuredOutput: true,
    schema: GENERATION_OUTPUT_SCHEMA,
    schemaName: 'resprout_interactive_output',
  }, call);
}

function repairExcerpt(content: string | null, rawOutput: string): string {
  const snippet = content ?? rawOutput;
  return snippet.length > 12000 ? `${snippet.slice(0, 4000)}\n……\n${snippet.slice(-8000)}` : snippet;
}

async function requestRepair(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  failure: InteractiveFailure,
  content: string | null,
  rawOutput: string,
  onDelta: ((output: string) => void) | undefined,
  call: CallContext,
): Promise<string> {
  const details = [
    `确定的错误：${failure.message}`,
    failure.details ? `证据：\n${failure.details}` : '',
  ].filter(Boolean).join('\n\n');
  return requestText([
    ...messages,
    {
      role: 'user',
      content: `你是交互页面的实现修复工程师。上一次生成的交互页面没有通过运行检查，请修正后重新输出完整结果。

${details}

当前输出或候选片段：
${repairExcerpt(content, rawOutput)}

只输出同一个 JSON 对象 {"html": "完整 HTML", "explanation": "简短知识说明"}，不要输出其他内容。修复必须真正解决上述确定错误，不要删除交互功能、隐藏错误状态或用静态内容伪装交互来通过检查。`,
    },
  ], model, onDelta ?? null, {
    purpose: 'interactive',
    structuredOutput: true,
    schema: GENERATION_OUTPUT_SCHEMA,
    schemaName: 'resprout_interactive_output',
  }, call);
}

function newCandidateId(): string {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `candidate:${random}`;
}

/**
 * 交互生成主流程：一次模型生成（HTML + 简短知识说明）→ 一次轻量运行检查 →
 * 确定的候选错误最多一次完整修复 → 再检查 → 展示或明确失败。
 * 模型调用预算：正常一次，最多两次；所有出口都在本函数内收尾。
 */
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
  const counters: InteractiveRunCounters = { modelCalls: 0, repairs: 0, checks: 0 };
  let repaired = false;

  const progress = (phase: InteractiveProgressPhase): void => {
    onProgress?.({ phase });
  };
  const stageStart = (): number => Date.now();

  const finalizeFailure = (
    stage: InteractiveStage,
    message: string,
    technicalStatus: TechnicalStatus,
    issues: InteractiveIssue[],
    summaryPrefix: string,
  ): FallbackInteractiveResult => {
    const summary = [
      summaryPrefix,
      message && message !== summaryPrefix ? `首因：${message}` : '',
      counters.repairs ? `经过 ${counters.repairs} 次修复` : '',
    ].filter(Boolean).join('；').slice(0, 400);
    return fallbackInteractiveResult(messages, topic, makeDiagnostic(
      stage,
      counters.modelCalls,
      startedAt,
      summary,
      {
        technicalStatus,
        runId,
        counters: { ...counters },
      },
    ), {
      technicalStatus,
      issues,
      runId,
      counters: { ...counters },
    });
  };

  const runCheck = async (content: string, candidateId: string, candidateHash: string): Promise<InteractiveReadinessResult> => {
    progress('check');
    counters.checks += 1;
    const checkStarted = stageStart();
    const check = await checkInteractiveReadiness(content, {
      signal,
      runId,
      candidateId,
      checkId: `${runId}:check:${counters.checks}`,
      candidateHash,
    });
    if (signal?.aborted || check.status === 'cancelled') throw abortError();
    diagnostics.recordCheck({
      checkId: check.checkId,
      candidateHash,
      candidateId,
      status: check.status,
      reason: check.reason,
      durationMs: check.durationMs,
    });
    diagnostics.recordStage('check', checkStarted, check.status === 'ready' ? 'ok' : 'failed', check.status);
    return check;
  };

  const publish = (content: string, candidateHash: string, explanation: string): GeneratedInteractiveResult => {
    const resolvedExplanation = explanation || fallbackExplanation(messages, topic, interactiveLearningStandard);
    diagnostics.recordStage(
      'publish',
      stageStart(),
      'ok',
      explanation ? '发布：一次生成通过运行检查' : '发布：说明缺失，已使用来源摘要降级',
    );
    return {
      content,
      fallback: false,
      reviewStatus: 'skipped',
      explanation: resolvedExplanation,
      technicalStatus: 'pass',
      readiness: 'ready',
      runId,
      counters: { ...counters },
      repaired,
      diagnostic: makeDiagnostic('done', counters.modelCalls, startedAt, [
        repaired ? '经过一次完整修复后通过运行检查' : '一次生成通过运行检查',
        !explanation ? '知识说明缺失，已使用来源摘要降级' : '',
      ].filter(Boolean).join('；'), {
        technicalStatus: 'pass',
        runId,
        candidateHash,
        counters: { ...counters },
      }),
    };
  };

  const checkFailure = (check: InteractiveReadinessResult): InteractiveFailure => ({
    stage: 'check',
    code: check.issue?.code ?? 'check-failed',
    message: check.reason || '页面没有通过运行检查',
    details: check.issue?.evidence ?? '',
  });

  const attemptRepair = async (failure: InteractiveFailure, content: string | null, rawOutput: string): Promise<InteractiveResult> => {
    progress('repair');
    counters.repairs += 1;
    counters.modelCalls += 1;
    const repairStarted = stageStart();
    let repairOutput: string;
    try {
      repairOutput = await requestRepair(messages, model, failure, content, rawOutput, onDelta, {
        purpose: 'repair',
        diagnostics,
        signal,
      });
    } catch (error) {
      if (isInteractiveAbortLike(error, signal)) throw abortError();
      if (isOutputTruncatedError(error)) {
        const issue = makeIssue('output-truncated', 'protocol', 'blocking', '修复输出达到 token 上限，页面内容被截断');
        diagnostics.recordRepair({ attempt: counters.repairs, summary: issue.message, applied: false, code: issue.code });
        return finalizeFailure('repair', issue.message, 'inconclusive', [issue], '修复输出被截断，无法获得完整 HTML');
      }
      throw stampStage(error, stageOf(error) ?? 'provider');
    }
    const parsed = parseInteractiveGenerationOutput(repairOutput, 'repair');
    if (!parsed.ok) {
      diagnostics.recordRepair({ attempt: counters.repairs, summary: parsed.message, applied: false, code: parsed.code });
      diagnostics.recordStage('repair', repairStarted, 'failed', parsed.message);
      const issue = makeIssue(parsed.code, 'protocol', 'blocking', parsed.message);
      return finalizeFailure('repair', parsed.message, 'inconclusive', [issue], '修复输出无效，已停止');
    }
    diagnostics.recordRepair({ attempt: counters.repairs, summary: '输出修复后的完整 HTML', applied: true, code: '' });
    diagnostics.recordStage('repair', repairStarted, 'ok', `${repairOutput.length} 字符修复输出`);
    repaired = true;
    const candidateId = newCandidateId();
    const candidateHash = hashText(parsed.html);
    diagnostics.recordCandidate({
      candidateId,
      content: parsed.html,
      rawContent: repairOutput,
      source: 'repair',
    });
    const check = await runCheck(parsed.html, candidateId, candidateHash);
    if (check.status === 'ready') return publish(parsed.html, candidateHash, parsed.explanation);
    const issue = check.issue ?? makeIssue('check-failed', 'runtime', 'blocking', check.reason || '修复后仍未通过运行检查');
    return finalizeFailure(
      'check',
      issue.message,
      readinessToTechnicalStatus(check.status),
      [issue],
      '修复后仍未通过运行检查，已停止',
    );
  };

  try {
    // 第一次模型调用：一次生成 HTML + 简短知识说明。
    progress('generation');
    counters.modelCalls += 1;
    const generationStarted = stageStart();
    let rawOutput: string;
    try {
      rawOutput = await requestGeneration(messages, model, onDelta, {
        purpose: 'generation',
        diagnostics,
        signal,
      });
    } catch (error) {
      if (isInteractiveAbortLike(error, signal)) throw abortError();
      if (isOutputTruncatedError(error)) {
        const failure: InteractiveFailure = {
          stage: 'generation',
          code: 'output-truncated',
          message: '模型输出达到 token 上限，页面内容被截断',
          details: '截断的输出无法保证结构完整，需要整体重新生成',
        };
        return attemptRepair(failure, null, recordValue(error, 'output') as string || '');
      }
      throw stampStage(error, stageOf(error) ?? 'provider');
    }
    diagnostics.recordStage('generation', generationStarted, 'ok', `${rawOutput.length} 字符原始输出`);
    const parsed = parseInteractiveGenerationOutput(rawOutput, 'generation');
    if (!parsed.ok) {
      const failure: InteractiveFailure = { stage: 'generation', code: parsed.code, message: parsed.message, details: '' };
      return attemptRepair(failure, null, rawOutput);
    }
    const candidateId = newCandidateId();
    const candidateHash = hashText(parsed.html);
    diagnostics.recordCandidate({
      candidateId,
      content: parsed.html,
      rawContent: rawOutput,
      source: 'initial',
    });

    // 第一次轻量运行检查。
    const check = await runCheck(parsed.html, candidateId, candidateHash);
    if (check.status === 'ready') return publish(parsed.html, candidateHash, parsed.explanation);
    if (check.status === 'unavailable') {
      const issue = makeIssue('check-unavailable', 'protocol', 'blocking', check.reason || '页面无法完成加载检查');
      return finalizeFailure('check', issue.message, 'inconclusive', [issue], '页面加载或检查环境失败，未修改 HTML');
    }
    // 确定的候选错误：使用唯一一次完整修复机会。
    return attemptRepair(checkFailure(check), parsed.html, rawOutput);
  } catch (error) {
    if (isInteractiveAbortError(error) || signal?.aborted) {
      throw abortError();
    }
    return finalizeFailure(
      stageOf(error) ?? 'provider',
      readableError(error),
      'inconclusive',
      [makeIssue('provider-failure', 'provider', 'blocking', readableError(error))],
      '生成服务失败，未修改 HTML',
    );
  } finally {
    diagnostics.setCounters({ ...counters });
    try {
      onDiagnostics?.(diagnostics);
    } catch {
      // 诊断回调失败不应影响生成结果
    }
  }
}
