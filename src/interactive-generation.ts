import { streamChat } from './api.ts';
import type { ChatModelRef, ChatOptions } from './api.ts';
import { originalContextMessages } from './context-budget.ts';
import type { LooseMessage, PromptMessage } from './context-budget.ts';
import { QUICK_ACTION_BOUNDARY } from './quick-actions.ts';
import { validateInteractiveDocument } from './interactive-runtime.ts';
import interactiveLearningStandard from './prompts/interactive-learning.md?raw';

const OUTPUT_TRUNCATED_CODE = 'INTERACTIVE_OUTPUT_TRUNCATED';
const EXCLUDED_MESSAGE_KINDS: readonly string[] = ['instruction', 'notice', 'meta'];

export type InteractiveStage = 'generation' | 'review' | 'runtime' | 'provider' | 'done';
export type InteractiveDiagnosticStage = InteractiveStage | (string & {});
export type InteractiveReviewStatus = 'reviewed' | 'skipped' | 'failed';

export interface InteractiveDiagnostic {
  stage: InteractiveDiagnosticStage;
  attempts: number;
  summary: string;
  durationMs: number;
}

export type InteractiveMessage = PromptMessage;

export interface GeneratedInteractiveResult {
  content: string;
  fallback: false;
  reviewStatus: 'reviewed' | 'skipped';
  explanation: string;
  diagnostic: InteractiveDiagnostic;
}

export interface FallbackInteractiveResult {
  content: '';
  fallback: true;
  reviewStatus: 'failed';
  explanation: string;
  diagnostic: InteractiveDiagnostic;
}

export type InteractiveResult = GeneratedInteractiveResult | FallbackInteractiveResult;

export interface RequestInteractiveHtmlOptions {
  onDelta?: ((output: string) => void) | undefined;
  onCandidate?: ((content: string, diagnostic: InteractiveDiagnostic) => void) | undefined;
  onReview?: ((attempt: number) => void) | undefined;
}

interface InteractiveReviewOutcome {
  content: string;
  explanation: string;
}

interface InteractiveReviewVerdict {
  pass: boolean;
  explanation?: unknown;
  problems?: unknown;
}

interface OutputTruncatedError {
  code: typeof OUTPUT_TRUNCATED_CODE;
  output: string;
}

interface ReviewRequestOptions {
  attempt: number;
  onAttempt?: ((attempt: number) => void) | undefined;
  onDelta?: ((output: string) => void) | undefined;
}

const INTERACTIVE_STAGES: ReadonlySet<string> = new Set(['generation', 'review', 'runtime', 'provider', 'done']);

function isInteractiveStage(value: unknown): value is InteractiveStage {
  return typeof value === 'string' && INTERACTIVE_STAGES.has(value);
}

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function lastMessage(
  messages: readonly LooseMessage[],
  predicate: (message: LooseMessage) => boolean,
): LooseMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && predicate(message)) return message;
  }
  return undefined;
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

function isOutputTruncatedError(error: unknown): error is OutputTruncatedError {
  const output = recordValue(error, 'output');
  return errorCode(error) === OUTPUT_TRUNCATED_CODE && typeof output === 'string' && output.length > 0;
}

export function buildInteractiveInstruction(topic: string): string {
  return `请把上述对话涉及的核心内容制作成一个交互解释页面${topic ? `，重点是“${topic}”` : ''}。\n\n${interactiveLearningStandard}`;
}

function normalizeInteractiveHtml(input: unknown): string {
  let text = String(input ?? '').trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = text.search(/<!doctype\s+<html|<html[\s>]|<main[\s>]|<section[\s>]|<div[\s>]|<canvas[\s>]|<svg[\s>]/i);
  if (start > 0) text = text.slice(start);
  for (const closing of ['</html>', '</main>']) {
    const end = text.toLowerCase().lastIndexOf(closing);
    if (end >= 0) {
      text = text.slice(0, end + closing.length);
      break;
    }
  }
  return text.trim();
}

export function extractInteractivePreview(output: string): string {
  const html = normalizeInteractiveHtml(output);
  return /<(?:html|main|section|div|canvas|svg)\b/i.test(html) ? html : '';
}

async function requestText(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  onDelta: ((output: string) => void) | null = null,
  options: ChatOptions = {},
): Promise<string> {
  let output = '';
  let stopReason = '';
  await streamChat(messages, event => {
    if (event.type === 'done') stopReason = event.stopReason ?? '';
    if (event.type !== 'text_delta') return;
    output += event.delta;
    onDelta?.(output);
  }, model, options);
  if (stopReason === 'length') {
    throw createInteractiveError('模型输出达到 token 上限，页面内容被截断', {
      code: OUTPUT_TRUNCATED_CODE,
      output,
    });
  }
  return output;
}

async function requestHtmlText(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  onDelta?: (output: string) => void,
): Promise<string> {
  try {
    return await requestText(messages, model, onDelta ?? null, { purpose: 'interactive' });
  } catch (error) {
    if (!isOutputTruncatedError(error)) throw error;
    const partial = error.output;
    const continuationMessages: InteractiveMessage[] = [
      ...messages,
      { role: 'assistant', content: partial },
      { role: 'user', content: '刚才的 HTML 在 token 上限处截断。请从最后一个字符之后继续，只输出剩余部分，不要重复已有内容，不要 Markdown 围栏或解释。' },
    ];
    try {
      const continuation = await requestText(continuationMessages, model, accumulated => onDelta?.(partial + accumulated), { purpose: 'interactive' });
      return partial + continuation;
    } catch (continuationError) {
      if (isOutputTruncatedError(continuationError)) {
        continuationError.output = partial + continuationError.output;
      }
      throw continuationError;
    }
  }
}

function focusedSelectionText(messages: readonly InteractiveMessage[]): string {
  const marker = '本次互动需要特别聚焦以下选中内容，不要偏离它：';
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  const message = [...context].reverse().find(item => typeof item.content === 'string' && item.content.startsWith(marker));
  return message ? message.content.slice(marker.length).trim() : '';
}

function sourceText(messages: readonly InteractiveMessage[]): string {
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  return context
    .filter(message => !EXCLUDED_MESSAGE_KINDS.includes(message.kind ?? '')
      && !message.content.includes(interactiveLearningStandard) && !message.content.startsWith('上一轮'))
    .map(message => message.content)
    .join('\n')
    .replaceAll(QUICK_ACTION_BOUNDARY, '');
}

function topicFor(messages: readonly InteractiveMessage[]): string {
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  return focusedSelectionText(messages)
    || lastMessage(context, message => message.kind === 'task')?.content
    || '当前知识点';
}

function fallbackExplanation(messages: readonly InteractiveMessage[], topic = topicFor(messages)): string {
  const source = sourceText(messages).trim();
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  const latest = lastMessage(context, message => message.kind === 'task')?.content;
  const excerpt = (focusedSelectionText(messages) || latest || source).slice(0, 1200);
  return `### ${topic || '当前知识点'}\n\n${excerpt || '当前内容暂未生成交互解释。'}`;
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
): InteractiveDiagnostic {
  return { stage, attempts, summary, durationMs: Date.now() - startedAt };
}

export function fallbackInteractiveResult(
  messages: readonly InteractiveMessage[],
  topic: string | undefined,
  diagnostic: InteractiveDiagnostic,
): FallbackInteractiveResult {
  return {
    content: '',
    fallback: true,
    reviewStatus: 'failed',
    explanation: fallbackExplanation(messages, topic),
    diagnostic,
  };
}

function extractJsonObjects(input: unknown): unknown[] {
  const values: unknown[] = [];
  const text = String(input ?? '').replace(/```(?:json)?/gi, '');
  let start = -1;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (string) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"' && depth) string = true;
    else if (character === '{') {
      if (!depth) start = index;
      depth += 1;
    } else if (character === '}' && depth) {
      depth -= 1;
      if (!depth) {
        try {
          const value: unknown = JSON.parse(text.slice(start, index + 1));
          values.push(value);
        } catch {
          // 跳过无法解析的 JSON 片段
        }
      }
    }
  }
  return values;
}

function isInteractiveReviewVerdict(value: unknown): value is InteractiveReviewVerdict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof recordValue(value, 'pass') === 'boolean';
}

async function requestHtmlReview(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  content: string,
  { attempt, onAttempt, onDelta }: ReviewRequestOptions,
): Promise<InteractiveReviewOutcome> {
  onAttempt?.(attempt);
  const selection = focusedSelectionText(messages);
  const source = sourceText(messages);
  const excerpt = source.length > 5000 ? `${source.slice(0, 1800)}\n……\n${source.slice(-3200)}` : source;
  const contextText = `${selection ? `本次选中的内容：\n${selection}\n\n` : ''}原始对话背景：\n${excerpt}`;
  const mathNote = /数学|公式|方程|矩阵|积分|导数|几何|概率|向量|函数|计算|单位|量纲|sin|cos|tan/i.test(`${contextText}\n${content}`)
    ? '本页涉及数学或定量内容。额外核验公式、数值、单位、维度、符号、边界情况和近似表述；独立复算能够确定的初始结果及操作后的结果，不要只检查代码是否能运行。'
    : '按通用知识交互复核，不要套用数学场景或要求数学字段。';
  let output: string;
  try {
    output = await requestText([{
      role: 'user',
      content: `独立复核以下交互解释页面。候选 HTML 已通过沙箱运行验收。只复核内容事实与交互逻辑，不要要求固定场景、字段、控件数量或交互形式。

通用检查：
1. 页面忠实于选中内容或最新问题，没有捏造来源或无关扩展。
2. 演示逻辑自洽，控件和按钮产生真实且有解释意义的变化。
3. 初始内容完整，近似结果、模拟和动画没有被描述成严格证明。
4. 如果页面只有静态 HTML/SVG、没有可执行脚本且控件未接宿主，必须判为不通过，不能只凭外观放行。
${mathNote}

${contextText}

候选 HTML：
${content}

复核通过后，撰写简洁的右侧知识说明 Markdown，包含直观理解、核心规律、简单例子；确有必要时补充常见误区，不要复述按钮操作。

只输出一个裁决 JSON：
{"pass":true,"explanation":"Markdown 知识说明"}
或 {"pass":false,"problems":["需要修正的具体问题"]}`,
    }], model, onDelta, {
      purpose: 'interactive-review', structuredOutput: true, schema: { type: 'object' },
    });
  } catch (error) {
    throw stampStage(error, errorCode(error) === OUTPUT_TRUNCATED_CODE ? 'review' : 'provider');
  }
  const verdict = extractJsonObjects(output).find(isInteractiveReviewVerdict);
  if (verdict?.pass === true) return { content, explanation: String(verdict.explanation ?? '').trim() };
  const problems = verdict && Array.isArray(verdict.problems)
    ? verdict.problems.filter((problem): problem is string => typeof problem === 'string' && problem.trim().length > 0)
    : [];
  throw createInteractiveError(problems.length ? problems.join('；') : '复核器未能给出明确结论', { stage: 'review' });
}

export async function requestInteractiveHtml(
  messages: readonly InteractiveMessage[],
  model: ChatModelRef | null,
  { onDelta, onCandidate, onReview }: RequestInteractiveHtmlOptions = {},
): Promise<InteractiveResult> {
  const startedAt = Date.now();
  const topic = topicFor(messages);
  let output = '';
  let issue = '';
  let stage: InteractiveStage = 'generation';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repair = attempt === 1 ? '' : `上一版在 ${stage} 阶段未通过：${issue}\n只修复相关问题，保留有效设计，重新输出完整 HTML。`;
    const retryMessages: InteractiveMessage[] = attempt === 1
      ? []
      : [
          { role: 'assistant', content: output },
          { role: 'user', content: repair },
        ];
    const requestMessages: InteractiveMessage[] = [
      ...messages,
      { role: 'user', content: '现在根据以上标准和原始材料实现交互解释页面。自由选择合适的交互与 JavaScript 逻辑，只输出完整 HTML 片段。' },
      ...retryMessages,
    ];
    try {
      try {
        output = normalizeInteractiveHtml(await requestHtmlText(requestMessages, model, onDelta));
      } catch (error) {
        throw stampStage(error, errorCode(error) === OUTPUT_TRUNCATED_CODE ? 'generation' : 'provider');
      }
      if (!/<(?:html|main|section|div|canvas|svg)\b/i.test(output)) {
        throw createInteractiveError('没有返回完整的交互 HTML', { stage: 'generation' });
      }
      const validation = await validateInteractiveDocument(output).catch(error => {
        throw stampStage(error, 'runtime');
      });
      const warnings: string[] = Array.isArray(validation.warnings) ? validation.warnings : [];

      onCandidate?.(output, makeDiagnostic('review', attempt, startedAt));
      try {
        const reviewed = await requestHtmlReview(messages, model, output, { attempt, onAttempt: onReview, onDelta });
        return {
          ...reviewed,
          fallback: false,
          reviewStatus: 'reviewed',
          diagnostic: makeDiagnostic('done', attempt, startedAt, warnings.join('；')),
        };
      } catch (error) {
        if (stageOf(error) !== 'provider') throw error;
        return {
          content: output,
          fallback: false,
          reviewStatus: 'skipped',
          explanation: fallbackExplanation(messages, topic),
          diagnostic: makeDiagnostic('review', attempt, startedAt, [...warnings, '语义复核暂不可用，当前页面已通过运行验收'].join('；')),
        };
      }
    } catch (error) {
      if (stageOf(error) === 'provider') {
        return fallbackInteractiveResult(messages, topic, makeDiagnostic('provider', attempt, startedAt, readableError(error)));
      }
      issue = readableError(error);
      stage = stageOf(error) ?? 'generation';
      if (attempt === 2) {
        return fallbackInteractiveResult(messages, topic, makeDiagnostic(stage, attempt, startedAt, issue));
      }
    }
  }
  return fallbackInteractiveResult(messages, topic, makeDiagnostic(stage, 2, startedAt, issue));
}
