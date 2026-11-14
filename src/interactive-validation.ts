/**
 * 交互技术结果的三态规则、结构化问题与旧卡片恢复评估。
 *
 * 三态（pass/fail/inconclusive）与问题分类现在只服务离线完整验收、诊断重放和
 * 旧卡片恢复；生产发布路径使用 readiness（见 interactive-runtime.ts），
 * 不得用本模块的规则间接否决 ready 结果。
 * 问题拆成 origin / severity / code / evidence；只有“确定、可复现、有证据的候选缺陷”
 * 才作为生产修复输入；观察不足时离线侧补充证据而不是盲改 HTML。
 */

export const TECHNICAL_STATUSES = ['pass', 'fail', 'inconclusive'] as const;
export type TechnicalStatus = (typeof TECHNICAL_STATUSES)[number];

export const ISSUE_ORIGINS = ['candidate', 'runtime', 'validator', 'provider', 'protocol'] as const;
export type InteractiveIssueOrigin = (typeof ISSUE_ORIGINS)[number];

export const ISSUE_SEVERITIES = ['blocking', 'advisory'] as const;
export type InteractiveIssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const INTERACTIVE_ISSUES = {
  emptyContent: 'empty-content',
  runtimeError: 'runtime-error',
  navigationUnload: 'navigation-unload',
  invalidOutput: 'invalid-output',
  canvasMissingContent: 'canvas-missing-content',
  svgMissingContent: 'svg-missing-content',
  canvasUnreadable: 'canvas-unreadable',
  noExecutableInteraction: 'no-executable-interaction',
  noObservedChange: 'no-observed-change',
  visualControlNoChange: 'visual-control-no-change',
  visualControlDeferred: 'visual-control-deferred',
  invalidInputUnverified: 'invalid-input-unverified',
  probeCoverageTruncated: 'probe-coverage-truncated',
  probeTargetMissing: 'probe-target-missing',
  contractInvalid: 'contract-invalid',
  contractCasesTruncated: 'contract-cases-truncated',
  contractActionUnsupported: 'contract-action-unsupported',
  contractTargetMissing: 'contract-target-missing',
  contractTargetInvalid: 'contract-target-invalid',
  contractTargetUnstable: 'contract-target-unstable',
  completionTimeout: 'completion-timeout',
  contractExpectationUnmet: 'contract-expectation-unmet',
  contractUnexpectedChange: 'contract-unexpected-change',
  responsiveOverflow: 'responsive-overflow',
  responsiveMainHidden: 'responsive-main-hidden',
  validationTimeout: 'validation-timeout',
  validationFailed: 'validation-failed',
  validationIncomplete: 'validation-incomplete',
  loadTimeout: 'load-timeout',
  validationCancelled: 'validation-cancelled',
  frameError: 'frame-error',
  protocolMismatch: 'protocol-mismatch',
  protocolViolation: 'protocol-violation',
} as const;

export type InteractiveIssueCode = (typeof INTERACTIVE_ISSUES)[keyof typeof INTERACTIVE_ISSUES] | (string & {});

/**
 * 这些 code 表示“无法确定候选有错”：验收超时、契约不支持、观察不到变化等。
 * 它们可以和 blocking 一起出现，但状态必须是 inconclusive，不能宣布 pass 或 fail。
 */
export const INCONCLUSIVE_ISSUE_CODES: ReadonlySet<string> = new Set([
  INTERACTIVE_ISSUES.validationTimeout,
  INTERACTIVE_ISSUES.validationIncomplete,
  INTERACTIVE_ISSUES.loadTimeout,
  INTERACTIVE_ISSUES.validationCancelled,
  INTERACTIVE_ISSUES.frameError,
  INTERACTIVE_ISSUES.protocolMismatch,
  INTERACTIVE_ISSUES.protocolViolation,
  INTERACTIVE_ISSUES.noObservedChange,
  INTERACTIVE_ISSUES.visualControlDeferred,
  INTERACTIVE_ISSUES.invalidInputUnverified,
  INTERACTIVE_ISSUES.probeCoverageTruncated,
  INTERACTIVE_ISSUES.probeTargetMissing,
  INTERACTIVE_ISSUES.contractCasesTruncated,
  INTERACTIVE_ISSUES.contractInvalid,
  INTERACTIVE_ISSUES.contractActionUnsupported,
  INTERACTIVE_ISSUES.contractTargetMissing,
  INTERACTIVE_ISSUES.contractTargetInvalid,
  INTERACTIVE_ISSUES.contractTargetUnstable,
  INTERACTIVE_ISSUES.completionTimeout,
  INTERACTIVE_ISSUES.canvasUnreadable,
]);

export interface InteractiveIssue {
  code: InteractiveIssueCode;
  origin: InteractiveIssueOrigin;
  severity: InteractiveIssueSeverity;
  message: string;
  evidence: string;
  step: number | null;
}

export interface InteractiveControlInfo {
  index: number;
  tag: string;
  type: string;
  label: string;
  visualControl: boolean;
}

export interface InteractiveValidationStepEvidence {
  index: number;
  control: string;
  action: string;
  before: string;
  after: string;
  text: string;
  changed: boolean;
  domChanged: boolean;
  visualChanged: boolean | null;
  waitedMs: number;
  issueCode: string;
}

export interface InteractiveValidationEvidence {
  phase: string;
  initialText: string;
  steps: InteractiveValidationStepEvidence[];
  totalSteps: number;
  truncated: boolean;
  omittedSteps: number;
  diagnostics: string;
  inventory: InteractiveControlInfo[];
}

export interface InteractiveValidationResult {
  status: TechnicalStatus;
  issues: InteractiveIssue[];
  evidence: InteractiveValidationEvidence;
  inventory: InteractiveControlInfo[];
  candidateHash: string;
  contractHash: string;
  runtimeVersion: string;
  validationId: string;
  durationMs: number;
  cached: boolean;
}

export const MAX_EVIDENCE_STEPS = 12;
const MAX_EVIDENCE_TEXT = 500;
const MAX_INITIAL_TEXT = 600;
const MAX_DIAGNOSTICS = 2400;
const MAX_INVENTORY = 24;

export function emptyValidationEvidence(): InteractiveValidationEvidence {
  return {
    phase: '',
    initialText: '',
    steps: [],
    totalSteps: 0,
    truncated: false,
    omittedSteps: 0,
    diagnostics: '',
    inventory: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isIssueOrigin(value: unknown): value is InteractiveIssueOrigin {
  return typeof value === 'string' && (ISSUE_ORIGINS as readonly string[]).includes(value);
}

function isIssueSeverity(value: unknown): value is InteractiveIssueSeverity {
  return typeof value === 'string' && (ISSUE_SEVERITIES as readonly string[]).includes(value);
}

export function readStepEvidence(value: unknown, index: number): InteractiveValidationStepEvidence | null {
  if (!isRecord(value)) return null;
  const control = textValue(value.control, 180);
  if (!control) return null;
  return {
    index,
    control,
    action: textValue(value.action, 180),
    before: textValue(value.before, 120),
    after: textValue(value.after, 120),
    text: textValue(value.text, MAX_EVIDENCE_TEXT),
    changed: booleanValue(value.changed) || booleanValue(value.domChanged) || booleanValue(value.visualChanged),
    domChanged: booleanValue(value.domChanged),
    visualChanged: typeof value.visualChanged === 'boolean' ? value.visualChanged : null,
    waitedMs: Math.round(numberValue(value.waitedMs)),
    issueCode: textValue(value.issueCode, 80),
  };
}

export function readControlInventory(value: unknown): InteractiveControlInfo[] {
  if (!Array.isArray(value)) return [];
  const inventory: InteractiveControlInfo[] = [];
  for (const item of value.slice(0, MAX_INVENTORY)) {
    if (!isRecord(item)) continue;
    const tag = textValue(item.tag, 20);
    if (!tag) continue;
    inventory.push({
      index: inventory.length,
      tag,
      type: textValue(item.type, 30),
      label: textValue(item.label, 120),
      visualControl: booleanValue(item.visualControl),
    });
  }
  return inventory;
}

/**
 * 保留失败步骤与核心用例：超过上限时保留最先两步和最后十步，
 * 并显式标记 truncated / omittedSteps，避免审核误以为已覆盖全部控件。
 */
export function readValidationEvidence(value: unknown): InteractiveValidationEvidence {
  const record = isRecord(value) ? value : {};
  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const parsed: InteractiveValidationStepEvidence[] = [];
  for (const item of rawSteps) {
    const step = readStepEvidence(item, parsed.length);
    if (step) parsed.push(step);
  }
  const declaredTotal = Math.max(numberValue(record.totalSteps, parsed.length), parsed.length);
  let retained = parsed;
  let omitted = Math.max(0, declaredTotal - parsed.length);
  if (parsed.length > MAX_EVIDENCE_STEPS) {
    const head = parsed.slice(0, 2);
    const tail = parsed.slice(-(MAX_EVIDENCE_STEPS - 2));
    retained = [...head, ...tail].map((step, index) => ({ ...step, index }));
    omitted += parsed.length - retained.length;
  }
  const initialText = textValue(record.initialText, MAX_INITIAL_TEXT);
  return {
    phase: textValue(record.phase, 120),
    initialText,
    steps: retained,
    totalSteps: declaredTotal,
    truncated: booleanValue(record.truncated) || omitted > 0 || initialText.length >= MAX_INITIAL_TEXT,
    omittedSteps: omitted,
    diagnostics: textValue(record.diagnostics, MAX_DIAGNOSTICS),
    inventory: readControlInventory(record.inventory),
  };
}

export function readValidationIssues(value: unknown): { issues: InteractiveIssue[]; malformed: number } {
  if (!Array.isArray(value)) return { issues: [], malformed: 0 };
  const issues: InteractiveIssue[] = [];
  let malformed = 0;
  for (const item of value.slice(0, 40)) {
    if (!isRecord(item)) {
      malformed += 1;
      continue;
    }
    const code = textValue(item.code, 80);
    const message = textValue(item.message, 600);
    if (!code || !message || !isIssueOrigin(item.origin) || !isIssueSeverity(item.severity)) {
      malformed += 1;
      continue;
    }
    issues.push({
      code,
      origin: item.origin,
      severity: item.severity,
      message,
      evidence: textValue(item.evidence, 800),
      step: typeof item.step === 'number' && Number.isInteger(item.step) ? item.step : null,
    });
  }
  return { issues, malformed };
}

export function deriveTechnicalStatus(issues: readonly InteractiveIssue[]): TechnicalStatus {
  if (issues.some(issue => issue.severity === 'blocking' && !INCONCLUSIVE_ISSUE_CODES.has(issue.code))) return 'fail';
  if (issues.some(issue => INCONCLUSIVE_ISSUE_CODES.has(issue.code))) return 'inconclusive';
  return 'pass';
}

export function makeIssue(
  code: InteractiveIssueCode,
  origin: InteractiveIssueOrigin,
  severity: InteractiveIssueSeverity,
  message: string,
  extra: { evidence?: string; step?: number | null } = {},
): InteractiveIssue {
  return {
    code,
    origin,
    severity,
    message,
    evidence: extra.evidence ?? '',
    step: extra.step ?? null,
  };
}

export function dedupeIssues(issues: readonly InteractiveIssue[]): InteractiveIssue[] {
  const seen = new Set<string>();
  const result: InteractiveIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.severity}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

export function blockingIssues(result: InteractiveValidationResult): InteractiveIssue[] {
  return result.issues.filter(issue => issue.severity === 'blocking' && !INCONCLUSIVE_ISSUE_CODES.has(issue.code));
}

export function inconclusiveIssues(result: InteractiveValidationResult): InteractiveIssue[] {
  return result.issues.filter(issue => INCONCLUSIVE_ISSUE_CODES.has(issue.code));
}

function mergeEvidence(results: readonly InteractiveValidationResult[]): InteractiveValidationEvidence {
  const steps: InteractiveValidationStepEvidence[] = [];
  let totalSteps = 0;
  let truncated = false;
  let omittedSteps = 0;
  let initialText = '';
  let phase = '';
  let diagnostics = '';
  let inventory: InteractiveControlInfo[] = [];
  for (const result of results) {
    const evidence = result.evidence;
    totalSteps += evidence.totalSteps;
    truncated = truncated || evidence.truncated;
    omittedSteps += evidence.omittedSteps;
    if (!initialText && evidence.initialText) initialText = evidence.initialText;
    if (!phase && evidence.phase) phase = evidence.phase;
    if (!diagnostics && evidence.diagnostics) diagnostics = evidence.diagnostics;
    if (!inventory.length && evidence.inventory.length) inventory = evidence.inventory;
    if (!inventory.length && result.inventory.length) inventory = result.inventory;
  }
  for (const result of results) steps.push(...result.evidence.steps);
  if (steps.length > MAX_EVIDENCE_STEPS) {
    const head = steps.slice(0, 2);
    const tail = steps.slice(-(MAX_EVIDENCE_STEPS - 2));
    const omitted = steps.length - MAX_EVIDENCE_STEPS;
    steps.length = 0;
    steps.push(...head, ...tail);
    omittedSteps += omitted;
    truncated = true;
  }
  return {
    phase,
    initialText,
    steps: steps.map((step, index) => ({ ...step, index })),
    totalSteps,
    truncated,
    omittedSteps,
    diagnostics,
    inventory,
  };
}

export function combineValidationResults(
  results: readonly InteractiveValidationResult[],
  base: { candidateHash: string; contractHash: string; runtimeVersion: string; validationId: string; durationMs: number },
): InteractiveValidationResult {
  const issues = dedupeIssues(results.flatMap(result => result.issues));
  const statuses = results.map(result => result.status);
  const status: TechnicalStatus = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('inconclusive') ? 'inconclusive' : 'pass';
  const inventory = results.find(result => result.inventory.length)?.inventory ?? [];
  return {
    status,
    issues,
    evidence: mergeEvidence(results),
    inventory,
    candidateHash: base.candidateHash,
    contractHash: base.contractHash,
    runtimeVersion: base.runtimeVersion,
    validationId: base.validationId,
    durationMs: base.durationMs,
    cached: false,
  };
}

export const CONTENT_REVIEW_OUTCOMES = ['pass', 'blocking', 'advisory', 'unknown'] as const;
export type ContentReviewOutcome = (typeof CONTENT_REVIEW_OUTCOMES)[number];

export type LegacyCardStatus = 'verified' | 'unverified' | 'rejected';

export interface LegacyCardAssessment {
  retain: boolean;
  status: LegacyCardStatus;
  reason: string;
}

export interface LegacyCardInput {
  hasContent: boolean;
  technical: TechnicalStatus;
  /** true=此前审核通过；false=此前审核失败；null=旧存档没有审核记录。 */
  reviewPassed: boolean | null;
}

/**
 * 旧卡片恢复：不能依据 warnings.length === 0 判定成功，也不把 inconclusive 冒充通过。
 * 只要旧内容存在就避免被失败的新候选覆盖；是否“已验证”由技术结果和审核记录共同决定。
 */
export function assessLegacyCard(input: LegacyCardInput): LegacyCardAssessment {
  if (!input.hasContent) return { retain: false, status: 'rejected', reason: '没有可保留的旧内容' };
  if (input.technical !== 'pass') {
    return {
      retain: true,
      status: 'rejected',
      reason: input.technical === 'inconclusive'
        ? '旧版本无法在当前运行时完成验收，保留内容但不视为通过'
        : '旧版本在当前运行验收中失败，保留内容但不视为通过',
    };
  }
  if (input.reviewPassed === true) {
    return { retain: true, status: 'verified', reason: '旧版本重新通过运行验收且此前已通过内容审核' };
  }
  if (input.reviewPassed === false) {
    return { retain: true, status: 'rejected', reason: '旧版本此前未通过内容审核，保留内容但未重新审核' };
  }
  return {
    retain: true,
    status: 'unverified',
    reason: '旧版本通过运行验收，但旧存档没有内容审核记录，未重新审核',
  };
}

export function technicalStatusLabel(status: TechnicalStatus | undefined): string {
  if (status === 'pass') return '技术验收通过';
  if (status === 'fail') return '技术验收失败';
  if (status === 'inconclusive') return '未能完成技术验证';
  return '技术状态未知';
}
