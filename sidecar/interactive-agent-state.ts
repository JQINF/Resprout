import { hashText, normalizeInteractiveHtml } from '../src/interactive-html.ts';
import {
  INTERACTIVE_VERIFICATION_VERSION,
  type InteractiveControlDiff,
  type InteractiveScopedCheckStatus,
  type InteractiveVerificationSummary,
  type InteractiveVisualCheckStatus,
} from '../src/interactive-verification.ts';

export const INTERACTIVE_AGENT_BUDGET = {
  /** 每个迭代周期的模型轮次额度；完成一次验证驱动迭代后刷新（周期数 = iterationsUsed + 1）。 */
  modelTurns: 36,
  /** 每个迭代周期的工具调用额度；同样随迭代刷新。 */
  toolCalls: 56,
  /** 全局写入硬顶，不随迭代刷新。 */
  writes: 32,
  /** 验证驱动的修复迭代：自上次写入以来存在 act 观察时的重写计入；每次迭代刷新轮次与工具额度。 */
  iterations: 6,
  timeoutMs: 480_000,
} as const;

export type PreviewAction = 'click' | 'set' | 'wait';
export interface PreviewViewport { width: number; height: number }
export interface AgentAction { action: PreviewAction; selector: string; value: string }
export type InputStatus = 'unchanged' | 'normalized' | 'rejected' | 'not_applicable';

export interface PreviewActionResult {
  requestedValue: string;
  actualValue: string;
  inputStatus: InputStatus;
  actualWaitMs: number | null;
}

export interface PreviewControlState { id: string; tag: string; value: string; text: string; visible: boolean }
export interface PreviewState {
  text: string;
  width: number;
  height: number;
  controls: PreviewControlState[];
  controlCount: number;
  textTruncated: boolean;
  controlsTruncated: boolean;
}

export interface PreviewObservationInput {
  state: PreviewState;
  errors: unknown[];
  image: string;
  truncated: boolean;
  truncation: string[];
  actionResult?: PreviewActionResult;
}

export interface AgentObservation {
  observationId: string;
  at: number;
  artifactRevision: number;
  contentHash: string;
  source: 'preview' | 'act';
  state: PreviewState;
  errors: unknown[];
  viewport: PreviewViewport;
  screenshot: { captured: boolean; deliveredToModel: boolean; bytes: number };
  truncated: boolean;
  truncation: string[];
  actionResult: PreviewActionResult | null;
}

export interface ArtifactIdentity {
  revision: number;
  contentHash: string;
  createdAt: number;
  characters: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const text = value.trim();
  if (text.length > limit) throw new Error(`${label}过长`);
  return text;
}

function stringList(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value.slice(0, maximum).map((item, index) => requiredText(item, `${label}[${index}]`, 1200));
}

export function parseAgentAction(value: unknown): AgentAction {
  if (!isRecord(value) || (value.action !== 'click' && value.action !== 'set' && value.action !== 'wait')) throw new Error('动作只支持 click、set、wait');
  const action = value.action;
  const target = action === 'wait' ? String(value.selector ?? '') : requiredText(value.selector, '选择器', 500);
  if (typeof value.value !== 'string' && value.value !== undefined) throw new Error('动作输入值必须是字符串');
  const actionValue = String(value.value ?? '');
  if (action === 'wait') {
    const duration = Number(actionValue);
    if (!actionValue.trim() || !Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0 || duration > 2000) throw new Error('wait 必须是 0–2000 毫秒的有限整数');
  }
  return { action, selector: target, value: actionValue };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

export class InteractiveAgentState {
  readonly artifacts: ArtifactIdentity[] = [];
  readonly observations: AgentObservation[] = [];
  html = '';
  explanation = '';
  submitted = false;
  verificationSummary: InteractiveVerificationSummary | null = null;
  private observationCounter = 0;
  private currentObservationId: string | null = null;
  private actsSinceWrite = 0;
  private iterationsUsed = 0;
  private readonly vision: boolean;

  constructor(vision: boolean) { this.vision = vision; }
  get artifact(): ArtifactIdentity | null { return this.artifacts.at(-1) ?? null; }
  /** 当前预算周期数：首周期 + 已完成的验证驱动迭代。轮次与工具调用额度按周期数倍增。 */
  get budgetPeriod(): number { return this.iterationsUsed + 1; }

  private sameArtifact(observation: AgentObservation, artifact: ArtifactIdentity): boolean {
    return observation.artifactRevision === artifact.revision && observation.contentHash === artifact.contentHash;
  }

  writeArtifact(htmlValue: unknown, explanationValue: unknown): ArtifactIdentity {
    if (this.artifacts.length >= INTERACTIVE_AGENT_BUDGET.writes) {
      throw new Error(`最多写入 ${INTERACTIVE_AGENT_BUDGET.writes} 个版本；如仍需修复，把剩余事项列入未确认清单`);
    }
    if (this.artifacts.length > 0 && this.actsSinceWrite > 0) {
      if (this.iterationsUsed >= INTERACTIVE_AGENT_BUDGET.iterations) {
        throw new Error(`修复迭代最多 ${INTERACTIVE_AGENT_BUDGET.iterations} 次，本轮迭代后预算不再刷新；请把剩余问题列入未确认清单后提交`);
      }
      this.iterationsUsed += 1;
    }
    const html = normalizeInteractiveHtml(requiredText(htmlValue, 'HTML', 180_000));
    if (!/<(?:html|main|section|div|canvas|svg)\b/i.test(html)) throw new Error('HTML 无效');
    if (typeof explanationValue !== 'string' || explanationValue.length > 12_000) throw new Error('知识说明无效或过长');
    this.html = html;
    this.explanation = explanationValue;
    const artifact: ArtifactIdentity = { revision: this.artifacts.length + 1, contentHash: hashText(html), createdAt: Date.now(), characters: html.length };
    this.artifacts.push(artifact);
    this.actsSinceWrite = 0;
    this.currentObservationId = null;
    this.verificationSummary = null;
    return artifact;
  }

  readArtifact() {
    const artifact = this.requireCurrentArtifact();
    return { revision: artifact.revision, contentHash: artifact.contentHash, html: this.html, explanation: this.explanation };
  }

  requireCurrentArtifact(): ArtifactIdentity {
    const artifact = this.artifact;
    if (!artifact) throw new Error('先写入作品');
    return artifact;
  }

  requirePreview(): AgentObservation {
    const artifact = this.requireCurrentArtifact();
    const observation = this.observations.find(item => item.observationId === this.currentObservationId);
    if (!observation || !this.sameArtifact(observation, artifact)) throw new Error('先预览当前版本');
    return observation;
  }

  recordObservation(input: PreviewObservationInput, context: { source: AgentObservation['source']; deliverImage?: boolean }): AgentObservation {
    const artifact = this.requireCurrentArtifact();
    const deliverImage = context.deliverImage !== false;
    const observation: AgentObservation = {
      observationId: `observation:${++this.observationCounter}`,
      at: Date.now(), artifactRevision: artifact.revision, contentHash: artifact.contentHash,
      source: context.source,
      state: clone(input.state), errors: clone(input.errors), viewport: { width: input.state.width, height: input.state.height },
      screenshot: { captured: Boolean(input.image), deliveredToModel: this.vision && deliverImage && Boolean(input.image), bytes: input.image ? Math.floor(input.image.length * 3 / 4) : 0 },
      truncated: input.truncated, truncation: [...input.truncation], actionResult: input.actionResult ? clone(input.actionResult) : null,
    };
    this.observations.push(observation);
    this.currentObservationId = observation.observationId;
    if (context.source === 'act') this.actsSinceWrite += 1;
    return observation;
  }

  /** 程序自动差分：同一版本内，最近一次全新加载的控件状态 vs 最新观察的控件状态。仅顾问证据，不做门禁。
   *  无 id 控件（如模型用 nth-child 选择器的按钮组）以 `TAG:序号` 作 fallback key。 */
  controlDiff(): InteractiveControlDiff | null {
    const artifact = this.artifact;
    if (!artifact) return null;
    const current = this.observations.filter(item => this.sameArtifact(item, artifact));
    const baseline = [...current].reverse().find(item => item.source === 'preview');
    const final = current.at(-1);
    if (!baseline || !final || baseline.observationId === final.observationId) return null;
    const keyed = (items: PreviewControlState[]): Map<string, PreviewControlState> => {
      const map = new Map<string, PreviewControlState>();
      items.forEach((control, index) => {
        const key = control.id || `${control.tag}:${index}`;
        if (!map.has(key)) map.set(key, control);
      });
      return map;
    };
    const before = keyed(baseline.state.controls);
    const after = keyed(final.state.controls);
    const changed: string[] = [];
    const unchanged: string[] = [];
    const readings: { id: string; tag: string; before: string; after: string }[] = [];
    for (const [key, control] of before) {
      const latest = after.get(key);
      if (!latest) continue;
      const signature = (item: PreviewControlState) => `${item.value}${item.text}${item.visible ? 'v' : 'h'}`;
      if (signature(control) === signature(latest)) { unchanged.push(key); continue; }
      changed.push(key);
      readings.push({ id: key, tag: latest.tag, before: (control.value || control.text).slice(0, 120), after: (latest.value || latest.text).slice(0, 120) });
    }
    if (!before.size) return null;
    return { compared: before.size, changed, unchanged, readings: readings.slice(0, 40) };
  }

  submit(value: unknown): InteractiveVerificationSummary {
    const artifact = this.requireCurrentArtifact();
    this.requirePreview();
    if (!isRecord(value) || !isRecord(value.visualCheck) || !isRecord(value.semanticCheck) || !Array.isArray(value.unverified)) {
      throw new Error('提交必须包含 visualCheck、semanticCheck 和 unverified');
    }
    const visualStatus: InteractiveVisualCheckStatus = value.visualCheck.status === 'completed' || value.visualCheck.status === 'inconclusive' ? value.visualCheck.status : 'not_performed';
    const visualSummary = requiredText(value.visualCheck.summary, '视觉自查说明');
    const semanticStatus: InteractiveScopedCheckStatus = value.semanticCheck.status === 'supported' || value.semanticCheck.status === 'contradicted' || value.semanticCheck.status === 'inconclusive' || value.semanticCheck.status === 'not_applicable'
      ? value.semanticCheck.status
      : 'inconclusive';
    const semanticSummary = requiredText(value.semanticCheck.summary, '语义自查说明');
    const semanticObservationIds = stringList(value.semanticCheck.observationIds ?? [], '语义观察引用', 32);
    const citedObservationIds = [...new Set([...stringList(value.observationIds ?? [], '观察引用', 32), ...semanticObservationIds])];
    if (!citedObservationIds.length) throw new Error('提交必须引用至少一个本版本的页面观察（observationIds）');
    for (const observationId of citedObservationIds) {
      const observation = this.observations.find(item => item.observationId === observationId);
      if (!observation) throw new Error(`观察不存在：${observationId}`);
      if (!this.sameArtifact(observation, artifact)) throw new Error(`不能引用旧版本的观察：${observationId}`);
    }
    if (!citedObservationIds.some(id => this.observations.find(item => item.observationId === id)?.source === 'act')) {
      throw new Error('提交必须引用至少一张操作之后的观察：先 preview 全新加载，再用 act 实际操作关键路径');
    }

    const unverified = value.unverified.map(item => requiredText(item, '未验证项', 1000));
    const addUnverified = (item: string): void => { if (!unverified.includes(item)) unverified.push(item); };
    const imageEvidence = this.observations.some(item => this.sameArtifact(item, artifact) && item.screenshot.deliveredToModel);
    const actionImageEvidence = this.observations.some(item => this.sameArtifact(item, artifact) && item.source === 'act' && item.screenshot.deliveredToModel);
    if (!this.vision) {
      addUnverified('视觉检查未执行：当前模型没有图片输入能力');
      if (visualStatus === 'completed') throw new Error('当前模型没有图片输入能力，视觉自查不能记为 completed');
    } else if (visualStatus === 'completed' && !actionImageEvidence) {
      throw new Error('视觉自查记为 completed 需要当前版本至少一张操作之后实际送达的截图');
    }
    const diff = this.controlDiff();
    if (diff && diff.changed.length === 0) addUnverified('程序差分未观察到任何控件值或文字变化，交互是否真正响应未被程序确认');

    const summary: InteractiveVerificationSummary = {
      version: INTERACTIVE_VERIFICATION_VERSION,
      artifactRevision: artifact.revision,
      contentHash: artifact.contentHash,
      visualCheck: { status: visualStatus, summary: visualSummary, imageEvidence },
      semanticCheck: { status: semanticStatus, summary: semanticSummary, observationIds: semanticObservationIds },
      controlDiff: diff,
      unverified,
    };
    this.verificationSummary = summary;
    this.submitted = true;
    return summary;
  }
}
