/**
 * 交互页面与宿主之间的共享运行协议。
 *
 * 宿主与注入 iframe 的运行时脚本共用这里的消息类型、协议版本和身份字段。
 * 运行时脚本由 `interactive-runtime-script.ts` 经转译后通过 `?raw` 注入，其中的
 * 常量占位符由 `serializeInteractiveProtocol()` 生成，避免复制字符串后拼错。
 */

import { INCONCLUSIVE_ISSUE_CODES, INTERACTIVE_ISSUES } from './interactive-validation.ts';

export const INTERACTIVE_PROTOCOL_VERSION = 1;
export const INTERACTIVE_RUNTIME_VERSION = '2026-11-15.1';

export const INTERACTIVE_TEST_CONFIG_ELEMENT_ID = 'resprout-test-config';
export const INTERACTIVE_TEST_CONTRACT_ELEMENT_ID = 'resprout-test-contract';

export const INTERACTIVE_MESSAGE_TYPES = {
  runtimeReady: 'resprout:runtime-ready',
  pageReady: 'resprout:page-ready',
  validationStart: 'resprout:validation-start',
  validationProgress: 'resprout:validation-progress',
  validationResult: 'resprout:validation-result',
  runtimeError: 'resprout:runtime-error',
  /** 生产轻量运行检查（readiness）的终态消息，只描述运行可用性。 */
  readinessResult: 'resprout:readiness-result',
  /** 展示 iframe 向宿主转发未处理错误；无运行身份，宿主按 source 校验。 */
  displayError: 'resprout:display-error',
  /** 宿主通知展示页 iframe 调整逻辑 viewport（保持既有展示行为）。 */
  resize: 'resprout:resize',
} as const;

export type InteractiveMessageType = (typeof INTERACTIVE_MESSAGE_TYPES)[keyof typeof INTERACTIVE_MESSAGE_TYPES];

const MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(Object.values(INTERACTIVE_MESSAGE_TYPES));

/** 终态消息；每个运行只接受一次。 */
export const TERMINAL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  INTERACTIVE_MESSAGE_TYPES.validationResult,
  INTERACTIVE_MESSAGE_TYPES.runtimeError,
  INTERACTIVE_MESSAGE_TYPES.readinessResult,
]);

/** 有效进展消息；只有通过校验的新序号才能重置无进展计时。 */
export const PROGRESS_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  INTERACTIVE_MESSAGE_TYPES.runtimeReady,
  INTERACTIVE_MESSAGE_TYPES.pageReady,
  INTERACTIVE_MESSAGE_TYPES.validationStart,
  INTERACTIVE_MESSAGE_TYPES.validationProgress,
]);

export interface InteractiveIdentity {
  runId: string;
  validationId: string;
  candidateId: string;
}

export interface InteractiveMessageEnvelope extends InteractiveIdentity {
  protocolVersion: number;
  type: InteractiveMessageType;
  sequence: number;
}

export interface ParsedInteractiveMessage extends InteractiveMessageEnvelope {
  data: Record<string, unknown>;
}

export type InteractiveMessageParseFailure =
  | 'not-object'
  | 'unknown-type'
  | 'protocol-version'
  | 'identity'
  | 'sequence';

export type ParseInteractiveMessageResult =
  | { ok: true; message: ParsedInteractiveMessage }
  | { ok: false; reason: InteractiveMessageParseFailure; detail: string };

export type ValidationGateDecision =
  | { action: 'ignore'; reason: string }
  | { action: 'progress'; message: ParsedInteractiveMessage }
  | { action: 'terminal'; message: ParsedInteractiveMessage };

const MAX_ID_LENGTH = 160;
const ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

export function isTerminalMessageType(type: string): boolean {
  return TERMINAL_MESSAGE_TYPES.has(type);
}

/**
 * 严格解析一条运行消息。身份字段、协议版本、序号和消息类型都必须匹配；
 * 页面自身伪造的消息不能把字段缺失的运行消息送进收尾逻辑。
 */
export function parseInteractiveMessage(value: unknown): ParseInteractiveMessageResult {
  if (!isRecord(value)) return { ok: false, reason: 'not-object', detail: '消息不是对象' };
  if (typeof value.type !== 'string' || !MESSAGE_TYPE_SET.has(value.type)) {
    return { ok: false, reason: 'unknown-type', detail: `未知消息类型：${String(value.type)}` };
  }
  if (value.protocolVersion !== INTERACTIVE_PROTOCOL_VERSION) {
    return { ok: false, reason: 'protocol-version', detail: `协议版本不符：${String(value.protocolVersion)}` };
  }
  if (!isIdentityPart(value.runId) || !isIdentityPart(value.validationId) || !isIdentityPart(value.candidateId)) {
    return { ok: false, reason: 'identity', detail: '缺少有效的运行身份字段' };
  }
  if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    return { ok: false, reason: 'sequence', detail: '序号无效' };
  }
  return {
    ok: true,
    message: {
      protocolVersion: INTERACTIVE_PROTOCOL_VERSION,
      type: value.type as InteractiveMessageType,
      runId: value.runId,
      validationId: value.validationId,
      candidateId: value.candidateId,
      sequence: value.sequence,
      data: value,
    },
  };
}

export function sameIdentity(identity: InteractiveIdentity, message: InteractiveIdentity): boolean {
  return identity.runId === message.runId
    && identity.validationId === message.validationId
    && identity.candidateId === message.candidateId;
}

/**
 * 每条运行一个 gate：只接受同一身份、递增序号的消息；重复/乱序/旧运行消息忽略；
 * 终态只收一次，之后的所有消息都不再改动结果。
 */
export class ValidationMessageGate {
  private readonly identity: InteractiveIdentity;
  private lastSequence = -1;
  private terminalSeen = false;

  constructor(identity: InteractiveIdentity) {
    this.identity = identity;
  }

  accept(message: ParsedInteractiveMessage): ValidationGateDecision {
    if (!sameIdentity(this.identity, message)) {
      return { action: 'ignore', reason: 'identity-mismatch' };
    }
    if (message.sequence <= this.lastSequence) {
      return { action: 'ignore', reason: 'stale-or-duplicate-sequence' };
    }
    if (this.terminalSeen) {
      return { action: 'ignore', reason: 'terminal-already-seen' };
    }
    this.lastSequence = message.sequence;
    if (isTerminalMessageType(message.type)) {
      this.terminalSeen = true;
      return { action: 'terminal', message };
    }
    return { action: 'progress', message };
  }

  get lastAcceptedSequence(): number {
    return this.lastSequence;
  }

  get hasTerminal(): boolean {
    return this.terminalSeen;
  }
}

/** 注入到运行时脚本中的常量；运行时用 `PROTOCOL.message.*` 读取。 */
export function serializeInteractiveProtocol(): string {
  return JSON.stringify({
    version: INTERACTIVE_PROTOCOL_VERSION,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    message: INTERACTIVE_MESSAGE_TYPES,
    issue: INTERACTIVE_ISSUES,
    inconclusiveCodes: [...INCONCLUSIVE_ISSUE_CODES],
    testConfigElementId: INTERACTIVE_TEST_CONFIG_ELEMENT_ID,
    testContractElementId: INTERACTIVE_TEST_CONTRACT_ELEMENT_ID,
  });
}

export type InteractiveRuntimeMode = 'display' | 'inspect' | 'probe' | 'case' | 'responsive' | 'readiness';

export interface InteractiveRuntimeLimits {
  /** 等待页面就绪（DOM 稳定/目标出现）的上限。 */
  readyTimeoutMs: number;
  /** 单个动作后等待稳定的上限。 */
  actionTimeoutMs: number;
  /** 判定“安静”的窗口长度。 */
  settleMs: number;
  /** 单次 iframe 运行的绝对总时限。 */
  totalTimeoutMs: number;
  /** 加载后多久没有 page-ready 视为加载失败。 */
  loadTimeoutMs: number;
  /** 首屏绘制（尤其异步 Canvas）的有界等待预算。 */
  firstPaintTimeoutMs: number;
  /** readiness 首屏观察窗口长度（仅 mode='readiness' 使用）。 */
  observeMs?: number;
}

export const DEFAULT_RUNTIME_LIMITS: InteractiveRuntimeLimits = {
  readyTimeoutMs: 2000,
  actionTimeoutMs: 2500,
  settleMs: 120,
  totalTimeoutMs: 20000,
  loadTimeoutMs: 8000,
  firstPaintTimeoutMs: 1500,
};

export interface InteractiveRuntimeConfig extends InteractiveIdentity {
  mode: Exclude<InteractiveRuntimeMode, 'display'>;
  probeIndex: number | null;
  case: unknown;
  limits: InteractiveRuntimeLimits;
}

export interface InteractiveRuntimeConfigInput extends Partial<InteractiveIdentity> {
  mode: Exclude<InteractiveRuntimeMode, 'display'>;
  probeIndex?: number | null;
  case?: unknown;
  limits?: Partial<InteractiveRuntimeLimits>;
}

export function createInteractiveRuntimeConfig(input: InteractiveRuntimeConfigInput): InteractiveRuntimeConfig {
  return {
    mode: input.mode,
    runId: input.runId ?? '',
    validationId: input.validationId ?? '',
    candidateId: input.candidateId ?? '',
    probeIndex: typeof input.probeIndex === 'number' && Number.isInteger(input.probeIndex) ? input.probeIndex : null,
    case: input.case ?? null,
    limits: { ...DEFAULT_RUNTIME_LIMITS, ...input.limits },
  };
}

export function createInteractiveIdentity(prefix = 'run'): InteractiveIdentity {
  const random = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    runId: `${prefix}:${random}`,
    validationId: `validation:${random}`,
    candidateId: `candidate:${random}`,
  };
}
