export const INTERACTIVE_VERIFICATION_VERSION = 3;

export type InteractiveVisualCheckStatus = 'completed' | 'inconclusive' | 'not_performed';
export type InteractiveScopedCheckStatus = 'supported' | 'contradicted' | 'inconclusive' | 'not_applicable';

export interface InteractiveScopedCheckSummary {
  status: InteractiveScopedCheckStatus;
  summary: string;
  observationIds: string[];
  requirementIds: string[];
  entityIds: string[];
  relationshipIds: string[];
  representationIds: string[];
}

export interface InteractiveSelfCheckSummary {
  status: InteractiveScopedCheckStatus;
  summary: string;
  observationIds: string[];
}

export interface InteractiveControlDiffReading {
  id: string;
  tag: string;
  before: string;
  after: string;
}

/** 程序自动差分：对照同一版本内最近一次全新加载与最新观察的控件状态，仅作顾问证据。 */
export interface InteractiveControlDiff {
  compared: number;
  changed: string[];
  unchanged: string[];
  readings: InteractiveControlDiffReading[];
}

/** v3 自查摘要：视觉/语义为模型分项自述，controlDiff 为程序自动产出的响应证据。 */
export interface InteractiveVerificationSummary {
  version: 3;
  artifactRevision: number;
  contentHash: string;
  visualCheck: {
    status: InteractiveVisualCheckStatus;
    summary: string;
    imageEvidence: boolean;
  };
  semanticCheck: InteractiveSelfCheckSummary;
  controlDiff: InteractiveControlDiff | null;
  unverified: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = 2000): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function strings(value: unknown, limit = 32): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 160)).slice(0, limit) : [];
}

function scopedStatus(value: unknown): InteractiveScopedCheckStatus {
  return value === 'supported' || value === 'contradicted' || value === 'inconclusive' || value === 'not_applicable' ? value : 'inconclusive';
}

export function sanitizeInteractiveVerificationSummary(value: unknown): InteractiveVerificationSummary | undefined {
  if (!isRecord(value) || value.version !== 3) return undefined;
  if (typeof value.artifactRevision !== 'number' || typeof value.contentHash !== 'string') return undefined;
  const visual = isRecord(value.visualCheck) ? value.visualCheck : {};
  const visualStatus = visual.status === 'completed' || visual.status === 'inconclusive' ? visual.status : 'not_performed';
  const semantic = isRecord(value.semanticCheck) ? value.semanticCheck : {};
  const diff = isRecord(value.controlDiff) ? value.controlDiff : null;
  return {
    version: 3,
    artifactRevision: value.artifactRevision,
    contentHash: value.contentHash,
    visualCheck: {
      status: visualStatus,
      summary: text(visual.summary),
      imageEvidence: visual.imageEvidence === true,
    },
    semanticCheck: {
      status: scopedStatus(semantic.status),
      summary: text(semantic.summary),
      observationIds: strings(semantic.observationIds),
    },
    controlDiff: diff && typeof diff.compared === 'number' ? {
      compared: diff.compared,
      changed: strings(diff.changed, 40),
      unchanged: strings(diff.unchanged, 40),
      readings: Array.isArray(diff.readings) ? diff.readings.slice(0, 40).flatMap(item => {
        if (!isRecord(item) || typeof item.id !== 'string') return [];
        return [{ id: item.id.slice(0, 80), tag: text(item.tag, 40), before: text(item.before, 200), after: text(item.after, 200) }];
      }) : [],
    } : null,
    unverified: Array.isArray(value.unverified) ? value.unverified.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 1000)).slice(0, 40) : [],
  };
}
