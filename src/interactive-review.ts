/**
 * 内容审核裁决的本地校验与分类（仅离线/显式评估边界）。
 *
 * 生产发布路径不再调用教学审核；本模块保留给离线评估脚本与单元测试使用。
 * 审核输出必须满足完整 schema：缺字段、通过但含阻断项、要求修改却没有任何问题，
 * 都视为不完整裁决；纯美观建议不触发自动修复。
 */

import { extractJsonObjects, isRecord, stringList, textValue } from './interactive-json.ts';
import type { ContentReviewOutcome } from './interactive-validation.ts';

export const REVIEW_KINDS = ['factual', 'interaction', 'visual', 'advisory'] as const;
export type ReviewIssueKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type ReviewConfidence = (typeof REVIEW_CONFIDENCES)[number];

export interface ReviewIssue {
  kind: ReviewIssueKind;
  severity: 'blocking' | 'advisory';
  code: string;
  problem: string;
  guidance: string;
  evidence: string;
  expected: string;
  confidence: ReviewConfidence;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'revise';
  issues: ReviewIssue[];
  checks: string[];
  repairScope: 'patch' | 'rewrite' | null;
}

export type ParseReviewResult =
  | { ok: true; verdict: ReviewVerdict }
  | { ok: false; reason: string };

export interface ReviewDecision {
  outcome: ContentReviewOutcome;
  publishable: boolean;
  blocking: ReviewIssue[];
  uncertain: ReviewIssue[];
  advisory: ReviewIssue[];
  repairScope: 'patch' | 'rewrite' | null;
  summary: string;
}

function isReviewKind(value: unknown): value is ReviewIssueKind {
  return typeof value === 'string' && (REVIEW_KINDS as readonly string[]).includes(value);
}

function isConfidence(value: unknown): value is ReviewConfidence {
  return typeof value === 'string' && (REVIEW_CONFIDENCES as readonly string[]).includes(value);
}

function validCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{2,40}$/.test(value);
}

function parseIssue(value: unknown): ReviewIssue | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const severity = value.severity;
  const code = value.code;
  const problem = textValue(value.problem);
  const guidance = textValue(value.guidance);
  const confidence = value.confidence;
  if (!isReviewKind(kind) || (severity !== 'blocking' && severity !== 'advisory')) return null;
  if (!validCode(code) || !problem || !guidance || !isConfidence(confidence)) return null;
  if (kind === 'advisory' && severity === 'blocking') return null;
  return {
    kind,
    severity,
    code,
    problem: problem.slice(0, 600),
    guidance: guidance.slice(0, 800),
    evidence: textValue(value.evidence).slice(0, 800),
    expected: textValue(value.expected).slice(0, 400),
    confidence,
  };
}

/**
 * 在模型文本中寻找裁决对象。只接受结构完整且内部一致的裁决：
 * - verdict 必须是 pass/revise；
 * - revise 必须至少有一个问题；pass 不允许带 blocking 问题；
 * - 问题必须带稳定 code、类型、严重度、修复方向和置信度。
 */
export function parseReviewVerdict(output: unknown): ParseReviewResult {
  let fallbackReason = '审核输出缺少完整的裁决 JSON';
  for (const value of extractJsonObjects(output)) {
    if (!isRecord(value)) continue;
    const verdictValue = value.verdict;
    if (verdictValue !== 'pass' && verdictValue !== 'revise') continue;
    if (!Array.isArray(value.issues)) {
      fallbackReason = '审核裁决缺少 issues 数组';
      continue;
    }
    const issues: ReviewIssue[] = [];
    let malformed = 0;
    for (const item of value.issues.slice(0, 20)) {
      const issue = parseIssue(item);
      if (!issue) {
        malformed += 1;
        continue;
      }
      issues.push(issue);
    }
    if (malformed) {
      fallbackReason = `审核裁决有 ${malformed} 条问题缺少必需字段`;
      continue;
    }
    const blocking = issues.filter(issue => issue.severity === 'blocking');
    if (verdictValue === 'pass' && blocking.length) {
      fallbackReason = '审核裁决为通过，但包含 blocking 问题';
      continue;
    }
    if (verdictValue === 'revise' && !issues.length) {
      fallbackReason = '审核要求修改但没有给出任何问题';
      continue;
    }
    const repairScope = value.repairScope === 'patch' || value.repairScope === 'rewrite' ? value.repairScope : null;
    return {
      ok: true,
      verdict: {
        verdict: verdictValue,
        issues,
        checks: stringList(value.checks).map(item => item.slice(0, 300)),
        repairScope,
      },
    };
  }
  return { ok: false, reason: fallbackReason };
}

/**
 * 审核分类：
 * - high/medium 置信度的 blocking 问题才触发修复；
 * - low 置信度的 blocking 问题进入补证据路径，不直接重写；
 * - 只有 advisory 问题时可发布并记录建议。
 */
export function decideReview(verdict: ReviewVerdict): ReviewDecision {
  const blocking = verdict.issues.filter(issue => issue.severity === 'blocking' && issue.confidence !== 'low');
  const uncertain = verdict.issues.filter(issue => issue.severity === 'blocking' && issue.confidence === 'low');
  const advisory = verdict.issues.filter(issue => issue.severity === 'advisory');
  let outcome: ContentReviewOutcome;
  if (blocking.length) outcome = 'blocking';
  else if (uncertain.length) outcome = 'unknown';
  else if (advisory.length) outcome = 'advisory';
  else outcome = 'pass';
  const repairScope = verdict.repairScope
    ?? (blocking.length > 2 ? 'rewrite' : 'patch');
  const summary = blocking.length
    ? blocking.map(issue => issue.problem).join('；')
    : uncertain.length
      ? `审核存在低置信度阻断问题：${uncertain.map(issue => issue.problem).join('；')}`
      : advisory.length
        ? `记录 ${advisory.length} 条优化建议，不触发自动修复`
        : '内容与交互审核通过';
  return {
    outcome,
    publishable: outcome === 'pass' || outcome === 'advisory',
    blocking,
    uncertain,
    advisory,
    repairScope: blocking.length ? repairScope : null,
    summary: summary.slice(0, 600),
  };
}

export function reviewFeedbackText(decision: ReviewDecision): string {
  const parts: string[] = [];
  if (decision.blocking.length) {
    parts.push(`失败问题：${decision.blocking.map(issue => `${issue.problem}（${issue.code}）`).join('；')}`);
    const guidance = decision.blocking.map(issue => issue.guidance).filter(Boolean);
    if (guidance.length) parts.push(`修复方向：\n${guidance.map(item => `- ${item}`).join('\n')}`);
    const expected = decision.blocking.map(issue => issue.expected).filter(Boolean);
    if (expected.length) parts.push(`预期结果：\n${expected.map(item => `- ${item}`).join('\n')}`);
  }
  if (decision.uncertain.length) {
    parts.push(`证据不足的问题：${decision.uncertain.map(issue => issue.problem).join('；')}。先补充可复现证据，不要仅凭猜测重写。`);
  }
  return parts.join('\n\n');
}
