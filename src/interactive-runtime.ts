/**
 * 交互 HTML 的构建与真实浏览器检查驱动。
 *
 * - `buildInteractiveDocument` 供展示节点、readiness 检查 iframe 和离线验收 iframe 共用；
 *   注入脚本来自 `interactive-runtime-script.js`，协议常量由共享模块序列化。
 * - `checkInteractiveReadiness` 是生产路径的轻量运行检查：单候选单 iframe，只确认
 *   页面能加载、首屏有可见主体、观察窗口内没有确定运行异常；不遍历控件、不执行
 *   契约、不扫描多视口、不做任何模型调用。ready 不证明所有交互或教学内容正确。
 * - `validateInteractiveCandidate` 是完整三态技术验收，仅服务离线诊断与测试：
 *   依次执行初始检查、契约用例或保守探针、真实窄屏检查；宿主负责绝对总时限、
 *   无进展超时、终态唯一、取消与清理，并把每次验收的问题和累计证据结构化返回。
 */

import runtimeSource from './interactive-runtime-script.js?raw';
import designCss from './interactive-design.css?raw';
import { extractInteractiveContract, MAX_CONTRACT_CASES } from './interactive-contract.ts';
import type { InteractiveContract, InteractiveContractCase } from './interactive-contract.ts';
import { hashText, hasInteractiveHtmlShape } from './interactive-html.ts';
import { normalizeInteractiveMath } from './interactive-math.ts';
import {
  createInteractiveIdentity,
  createInteractiveRuntimeConfig,
  INTERACTIVE_MESSAGE_TYPES,
  INTERACTIVE_RUNTIME_VERSION,
  INTERACTIVE_TEST_CONFIG_ELEMENT_ID,
  parseInteractiveMessage,
  serializeInteractiveProtocol,
  ValidationMessageGate,
} from './interactive-protocol.ts';
import type {
  InteractiveIdentity,
  InteractiveRuntimeConfig,
  InteractiveRuntimeLimits,
  ParsedInteractiveMessage,
} from './interactive-protocol.ts';
import {
  combineValidationResults,
  dedupeIssues,
  deriveTechnicalStatus,
  emptyValidationEvidence,
  INCONCLUSIVE_ISSUE_CODES,
  INTERACTIVE_ISSUES,
  makeIssue,
  readControlInventory,
  readValidationEvidence,
  readValidationIssues,
} from './interactive-validation.ts';
import type {
  InteractiveControlInfo,
  InteractiveIssue,
  InteractiveValidationEvidence,
  InteractiveValidationResult,
  TechnicalStatus,
} from './interactive-validation.ts';

const PROTOCOL_SOURCE_PLACEHOLDER = '__RESPROUT_PROTOCOL__';
const RUNTIME_SOURCE = runtimeSource.replace(PROTOCOL_SOURCE_PLACEHOLDER, () => serializeInteractiveProtocol());
const RUNTIME_SCRIPT = `<script id="resprout-runtime">${RUNTIME_SOURCE}</script>`;
const DESIGN_STYLES = `<style>${designCss}</style>`;
const METADATA = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;

const DEFAULT_LIMITS: InteractiveRuntimeLimits = {
  readyTimeoutMs: 2000,
  actionTimeoutMs: 2500,
  settleMs: 120,
  totalTimeoutMs: 15000,
  loadTimeoutMs: 8000,
  firstPaintTimeoutMs: 1500,
};

const DEFAULT_OVERALL_TIMEOUT_MS = 45000;
const DEFAULT_VIEWPORT = { width: 960, height: 640 };
const RESPONSIVE_VIEWPORT = { width: 390, height: 700 };
const MAX_PROBES = 12;
const CACHE_LIMIT = 24;

export interface BuildInteractiveDocumentOptions {
  testConfig?: InteractiveRuntimeConfig | null;
}

function testConfigMarkup(config: InteractiveRuntimeConfig | null | undefined): string {
  if (!config) return '';
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script id="${INTERACTIVE_TEST_CONFIG_ELEMENT_ID}" type="application/json">${json}</script>`;
}

export function buildInteractiveDocument(content: string, options: BuildInteractiveDocumentOptions = {}): string {
  const html = normalizeInteractiveMath(String(content ?? ''));
  const metadata = `${METADATA}${testConfigMarkup(options.testConfig)}${RUNTIME_SCRIPT}`;
  if (/<html[\s>]/i.test(html)) {
    // 注意：`<header ...>`（生成页面常用的 rs-head 区域）不能被误判为 <head>，
    // 否则宿主样式注入会丢失——只允许 <head> 或 <head ...> 两种真实头部写法。
    if (/<head(?:\s[^>]*)?>/i.test(html)) {
      const withRuntime = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${metadata}`);
      if (/<\/head>/i.test(withRuntime)) return withRuntime.replace(/<\/head>/i, `${DESIGN_STYLES}</head>`);
      return withRuntime;
    }
    return html.replace(/<html[^>]*>/i, match => `${match}<head>${metadata}${DESIGN_STYLES}</head>`);
  }
  return `<!doctype html><html><head>${metadata}${DESIGN_STYLES}</head><body>${html}</body></html>`;
}

type FrameSettle = {
  status: TechnicalStatus;
  issues: InteractiveIssue[];
  evidence: InteractiveValidationEvidence;
  inventory: InteractiveControlInfo[];
};

interface FrameRunOptions {
  content: string;
  config: InteractiveRuntimeConfig;
  candidateHash: string;
  contractHash: string;
  viewport: { width: number; height: number };
  signal?: AbortSignal | undefined;
  totalTimeoutMs: number;
  loadTimeoutMs: number;
}

function cancelledResult(identity: InteractiveIdentity, candidateHash: string, contractHash: string, message: string): InteractiveValidationResult {
  return {
    status: 'inconclusive',
    issues: [makeIssue(INTERACTIVE_ISSUES.validationCancelled, 'validator', 'blocking', message)],
    evidence: emptyValidationEvidence(),
    inventory: [],
    candidateHash,
    contractHash,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    validationId: identity.validationId,
    durationMs: 0,
    cached: false,
  };
}

function settleResult(
  settle: FrameSettle,
  context: { candidateHash: string; contractHash: string; validationId: string; durationMs: number },
): InteractiveValidationResult {
  return {
    status: settle.status,
    issues: dedupeIssues(settle.issues),
    evidence: settle.evidence,
    inventory: settle.inventory,
    candidateHash: context.candidateHash,
    contractHash: context.contractHash,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    validationId: context.validationId,
    durationMs: context.durationMs,
    cached: false,
  };
}

function readFrameValidationResult(
  message: ParsedInteractiveMessage,
  fallbackEvidence: InteractiveValidationEvidence,
  malformedMessages: number,
): FrameSettle {
  const data = message.data;
  const statusValue = data.status;
  const issueRead = readValidationIssues(data.issues);
  const issues = issueRead.issues.slice();
  const evidence = readValidationEvidence(data.evidence);
  if (!evidence.phase) evidence.phase = typeof data.summary === 'string' ? data.summary.slice(0, 120) : '';
  if (!evidence.steps.length && fallbackEvidence.steps.length) {
    evidence.steps = fallbackEvidence.steps;
    evidence.totalSteps = fallbackEvidence.totalSteps;
    evidence.truncated = fallbackEvidence.truncated;
    evidence.omittedSteps = fallbackEvidence.omittedSteps;
  }
  if (!evidence.initialText && fallbackEvidence.initialText) evidence.initialText = fallbackEvidence.initialText;
  if (!evidence.diagnostics && fallbackEvidence.diagnostics) evidence.diagnostics = fallbackEvidence.diagnostics;
  const inventory = readControlInventory(data.inventory);
  if (malformedMessages) {
    evidence.diagnostics = `${evidence.diagnostics}\n收到 ${malformedMessages} 条字段不完整的运行消息`.trim();
  }
  if (statusValue !== 'pass' && statusValue !== 'fail' && statusValue !== 'inconclusive') {
    issues.push(makeIssue(
      INTERACTIVE_ISSUES.protocolViolation,
      'protocol',
      'blocking',
      `验收结果状态无效：${String(statusValue)}`,
    ));
    return {
      status: 'inconclusive',
      issues: dedupeIssues(issues),
      evidence,
      inventory,
    };
  }
  if (issueRead.malformed) {
    issues.push(makeIssue(
      INTERACTIVE_ISSUES.protocolViolation,
      'protocol',
      'advisory',
      `验收结果包含 ${issueRead.malformed} 条字段不完整的问题`,
    ));
  }
  let status: TechnicalStatus = statusValue;
  const blocking = issues.filter(issue => issue.severity === 'blocking' && !INCONCLUSIVE_ISSUE_CODES.has(issue.code));
  if (status === 'fail' && !blocking.length) {
    issues.push(makeIssue(INTERACTIVE_ISSUES.validationFailed, 'validator', 'blocking', '运行验收判定失败但没有提供结构化阻断问题'));
  }
  const derived = deriveTechnicalStatus(issues);
  if (status === 'pass' && derived !== 'pass') status = derived;
  if (status === 'fail' && derived === 'pass') status = 'fail';
  if (status === 'inconclusive' && derived === 'fail') status = 'fail';
  if (status === 'inconclusive' && !issues.some(issue => INCONCLUSIVE_ISSUE_CODES.has(issue.code))) {
    issues.push(makeIssue(INTERACTIVE_ISSUES.validationIncomplete, 'validator', 'blocking', '验收结论为 inconclusive，但没有说明证据不足的原因'));
  }
  return { status, issues: dedupeIssues(issues), evidence, inventory };
}

function runValidationFrame(options: FrameRunOptions): Promise<InteractiveValidationResult> {
  const { config, candidateHash, contractHash, viewport } = options;
  if (options.signal?.aborted) {
    return Promise.resolve(cancelledResult(config, candidateHash, contractHash, '验收已取消'));
  }
  const startedAt = Date.now();
  const identity: InteractiveIdentity = {
    runId: config.runId,
    validationId: config.validationId,
    candidateId: config.candidateId,
  };
  return new Promise<InteractiveValidationResult>(resolve => {
    let settled = false;
    let pageReady = false;
    let loadCount = 0;
    let malformedMessages = 0;
    let lastStage = '文档未加载';
    let lastEvidence = emptyValidationEvidence();
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const gate = new ValidationMessageGate(identity);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${viewport.width}px;height:${viewport.height}px;opacity:0;pointer-events:none;`;
    const documentUrl = URL.createObjectURL(new Blob([buildInteractiveDocument(options.content, { testConfig: config })], { type: 'text/html' }));

    const cleanup = (): void => {
      clearTimeout(loadTimer);
      clearTimeout(inactivityTimer);
      clearTimeout(absoluteTimer);
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(documentUrl);
      frame.remove();
    };
    const finish = (settle: FrameSettle): void => {
      if (settled) return;
      settled = true;
      const result = settleResult(settle, {
        candidateHash,
        contractHash,
        validationId: config.validationId,
        durationMs: Date.now() - startedAt,
      });
      cleanup();
      resolve(result);
    };
    const timeoutResult = (kind: 'load' | 'inactivity' | 'absolute'): void => {
      if (settled) return;
      const code = kind === 'load' || !pageReady
        ? INTERACTIVE_ISSUES.loadTimeout
        : INTERACTIVE_ISSUES.validationTimeout;
      const label = kind === 'absolute' ? '绝对总时限' : kind === 'load' ? '加载时限' : '无进展时限';
      finish({
        status: 'inconclusive',
        issues: [makeIssue(code, 'validator', 'blocking', `交互运行验收超出${label}（${lastStage}）`, {
          evidence: lastEvidence.truncated
            ? `证据已截断，省略 ${lastEvidence.omittedSteps} 步`
            : `最后阶段：${lastStage}`,
        })],
        evidence: lastEvidence,
        inventory: lastEvidence.inventory,
      });
    };
    const armInactivity = (): void => {
      clearTimeout(inactivityTimer);
      const inactivityMs = Math.max(4000, config.limits.actionTimeoutMs + 3000);
      inactivityTimer = setTimeout(() => timeoutResult('inactivity'), inactivityMs);
    };
    const onAbort = (): void => {
      finish({
        status: 'inconclusive',
        issues: [makeIssue(INTERACTIVE_ISSUES.validationCancelled, 'validator', 'blocking', '验收已取消')],
        evidence: lastEvidence,
        inventory: lastEvidence.inventory,
      });
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.contentWindow) return;
      if (settled) return;
      const parsed = parseInteractiveMessage(event.data);
      if (!parsed.ok) {
        malformedMessages += 1;
        if (malformedMessages >= 8) {
          finish({
            status: 'inconclusive',
            issues: [makeIssue(
              INTERACTIVE_ISSUES.protocolViolation,
              'protocol',
              'blocking',
              `运行消息协议持续不匹配（${parsed.reason}：${parsed.detail}）`,
            )],
            evidence: lastEvidence,
            inventory: lastEvidence.inventory,
          });
        }
        return;
      }
      const decision = gate.accept(parsed.message);
      if (decision.action === 'ignore') return;
      armInactivity();
      if (decision.action === 'terminal') {
        if (decision.message.type === INTERACTIVE_MESSAGE_TYPES.runtimeError) {
          const data = decision.message.data;
          finish({
            status: 'fail',
            issues: [makeIssue(
              INTERACTIVE_ISSUES.runtimeError,
              'runtime',
              'blocking',
              typeof data.message === 'string' ? data.message.slice(0, 400) : '交互运行失败',
              { evidence: typeof data.diagnostics === 'string' ? data.diagnostics.slice(0, 1200) : '' },
            )],
            evidence: lastEvidence,
            inventory: lastEvidence.inventory,
          });
          return;
        }
        finish(readFrameValidationResult(decision.message, lastEvidence, malformedMessages));
        return;
      }
      const message = decision.message;
      const data = message.data;
      if (message.type === INTERACTIVE_MESSAGE_TYPES.pageReady) {
        pageReady = true;
        lastStage = '页面已初始化';
        clearTimeout(loadTimer);
        if (data.width && data.height) {
          lastEvidence.phase = `页面就绪 ${String(data.width)}×${String(data.height)}`;
        }
        return;
      }
      if (message.type === INTERACTIVE_MESSAGE_TYPES.validationProgress) {
        const stage = typeof data.stage === 'string' ? data.stage : '验收进行中';
        const index = Number(data.index);
        const total = Number(data.total);
        const position = Number.isInteger(index) && Number.isInteger(total) && total > 0 ? ` ${index}/${total}` : '';
        lastStage = `${stage}${position}`;
        lastEvidence = readValidationEvidence(data.evidence);
        lastEvidence.phase = lastStage;
        return;
      }
      if (message.type === INTERACTIVE_MESSAGE_TYPES.validationStart) {
        lastStage = '验收开始';
        return;
      }
      if (message.type === INTERACTIVE_MESSAGE_TYPES.runtimeReady) {
        lastStage = '运行时已加载，等待首屏完成';
      }
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      loadCount += 1;
      // 第二次 load 说明验收期间发生了导航或重载。pagehide 消息可能随文档销毁丢失，
      // 宿主侧必须独立识别，并且优先于之后的无进展超时。
      if (loadCount > 1 && pageReady && !settled) {
        finish({
          status: 'fail',
          issues: [makeIssue(
            INTERACTIVE_ISSUES.navigationUnload,
            'runtime',
            'blocking',
            `页面在运行验收中重新加载或导航（${lastStage}）`,
            { evidence: '验收期间应保持同一文档运行；检查是否触发页面跳转、重载或表单提交' },
          )],
          evidence: lastEvidence,
          inventory: lastEvidence.inventory,
        });
        return;
      }
      if (!pageReady) lastStage = '文档已加载，等待页面初始化';
    });
    frame.addEventListener('error', () => {
      finish({
        status: 'inconclusive',
        issues: [makeIssue(INTERACTIVE_ISSUES.frameError, 'validator', 'blocking', '验收 iframe 加载失败')],
        evidence: lastEvidence,
        inventory: [],
      });
    });
    try {
      frame.src = documentUrl;
      document.body.appendChild(frame);
    } catch (error) {
      finish({
        status: 'inconclusive',
        issues: [makeIssue(
          INTERACTIVE_ISSUES.frameError,
          'validator',
          'blocking',
          `无法创建验收 iframe：${error instanceof Error ? error.message : String(error)}`,
        )],
        evidence: lastEvidence,
        inventory: [],
      });
    }
    loadTimer = setTimeout(() => timeoutResult('load'), options.loadTimeoutMs);
    absoluteTimer = setTimeout(() => timeoutResult('absolute'), options.totalTimeoutMs);
    armInactivity();
  });
}

export interface InteractiveValidationOptions {
  signal?: AbortSignal | undefined;
  runId?: string;
  candidateId?: string;
  validationId?: string;
  candidateHash?: string;
  viewport?: { width: number; height: number };
  enableResponsive?: boolean;
  useCache?: boolean;
  contract?: InteractiveContract | null;
  limits?: Partial<InteractiveRuntimeLimits>;
  overallTimeoutMs?: number;
}

const validationCache = new Map<string, InteractiveValidationResult>();

export function clearInteractiveValidationCache(): void {
  validationCache.clear();
}

function cachedClone(result: InteractiveValidationResult, validationId: string): InteractiveValidationResult {
  return {
    ...result,
    validationId,
    durationMs: 0,
    cached: true,
    issues: result.issues.map(issue => ({ ...issue })),
    evidence: {
      ...result.evidence,
      steps: result.evidence.steps.map(step => ({ ...step })),
      inventory: result.evidence.inventory.map(item => ({ ...item })),
    },
    inventory: result.inventory.map(item => ({ ...item })),
  };
}

function withExtraIssues(result: InteractiveValidationResult, extra: InteractiveIssue[]): InteractiveValidationResult {
  if (!extra.length) return result;
  const issues = dedupeIssues([...result.issues, ...extra]);
  return { ...result, issues, status: deriveTechnicalStatus(issues) };
}

function extractContractForValidation(content: string, provided: InteractiveContract | null | undefined): {
  contract: InteractiveContract | null;
  issues: InteractiveIssue[];
  fatal: InteractiveIssue | null;
  contractHash: string;
} {
  if (provided !== undefined) {
    const value = provided ?? null;
    return {
      contract: value,
      issues: [],
      fatal: null,
      contractHash: value ? hashText(JSON.stringify(value)) : 'none',
    };
  }
  const extracted = extractInteractiveContract(content);
  if (!extracted.ok) {
    return {
      contract: null,
      issues: [],
      fatal: makeIssue(INTERACTIVE_ISSUES.contractInvalid, 'protocol', 'blocking', `页面测试契约无效：${extracted.reason}`),
      contractHash: 'invalid',
    };
  }
  const issues: InteractiveIssue[] = [];
  if (extracted.contract?.sourceTruncated) {
    issues.push(makeIssue(
      INTERACTIVE_ISSUES.contractCasesTruncated,
      'validator',
      'advisory',
      `契约用例超过 ${MAX_CONTRACT_CASES} 个，超出部分未执行`,
    ));
  }
  for (const problem of extracted.issues) {
    issues.push(makeIssue(INTERACTIVE_ISSUES.contractInvalid, 'protocol', 'advisory', problem));
  }
  return {
    contract: extracted.contract,
    issues,
    fatal: null,
    contractHash: extracted.contract ? hashText(JSON.stringify(extracted.contract)) : 'none',
  };
}

/**
 * 对候选执行完整技术验收。返回三态结果而不是抛异常；只有调用方取消/基础设施
 * 失败也以 inconclusive 表示，由生成流水线决定补证据、修复还是明确失败。
 */
export async function validateInteractiveCandidate(
  content: string,
  options: InteractiveValidationOptions = {},
): Promise<InteractiveValidationResult> {
  const startedAt = Date.now();
  const identity = createInteractiveIdentity('validation-run');
  const runId = options.runId ?? identity.runId;
  const candidateId = options.candidateId ?? identity.candidateId;
  const validationId = options.validationId ?? identity.validationId;
  const candidateHash = options.candidateHash ?? hashText(content);
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const deadline = startedAt + overallTimeoutMs;
  if (options.signal?.aborted) {
    return cancelledResult({ runId, candidateId, validationId }, candidateHash, 'none', '验收已取消');
  }
  if (!hasInteractiveHtmlShape(content)) {
    return {
      status: 'fail',
      issues: [makeIssue(INTERACTIVE_ISSUES.emptyContent, 'candidate', 'blocking', '没有返回完整的交互 HTML')],
      evidence: emptyValidationEvidence(),
      inventory: [],
      candidateHash,
      contractHash: 'none',
      runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
      validationId,
      durationMs: Date.now() - startedAt,
      cached: false,
    };
  }
  const contractInfo = extractContractForValidation(content, options.contract);
  if (contractInfo.fatal) {
    return {
      status: 'inconclusive',
      issues: [contractInfo.fatal],
      evidence: emptyValidationEvidence(),
      inventory: [],
      candidateHash,
      contractHash: contractInfo.contractHash,
      runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
      validationId,
      durationMs: Date.now() - startedAt,
      cached: false,
    };
  }
  const contract = contractInfo.contract;
  const contractHash = contractInfo.contractHash;
  const enableResponsive = options.enableResponsive !== false;
  const baseLimits: InteractiveRuntimeLimits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
  };
  const cacheKey = [
    candidateHash,
    contractHash,
    INTERACTIVE_RUNTIME_VERSION,
    enableResponsive ? 'responsive' : 'plain',
    `${options.viewport?.width ?? DEFAULT_VIEWPORT.width}x${options.viewport?.height ?? DEFAULT_VIEWPORT.height}`,
  ].join('|');
  if (options.useCache !== false) {
    const cached = validationCache.get(cacheKey);
    if (cached) return cachedClone(cached, validationId);
  }

  let frameIndex = 0;
  const frameIdentity = (): InteractiveIdentity => {
    frameIndex += 1;
    return { runId, candidateId, validationId: `${validationId}:f${frameIndex}` };
  };
  const remainingLimits = (overrides: Partial<InteractiveRuntimeLimits> = {}): InteractiveRuntimeLimits => {
    const remaining = deadline - Date.now();
    return {
      ...baseLimits,
      ...overrides,
      totalTimeoutMs: Math.max(1500, Math.min(baseLimits.totalTimeoutMs, remaining)),
    };
  };
  const limitsForFrame = (overrides: Partial<InteractiveRuntimeLimits> = {}): InteractiveRuntimeLimits => remainingLimits(overrides);
  const runFrame = async (
    mode: InteractiveRuntimeConfig['mode'],
    extra: { probeIndex?: number; case?: InteractiveContractCase },
    viewport: { width: number; height: number },
    overrides: Partial<InteractiveRuntimeLimits> = {},
  ): Promise<InteractiveValidationResult> => {
    const limits = limitsForFrame(overrides);
    const config = createInteractiveRuntimeConfig({
      ...frameIdentity(),
      mode,
      probeIndex: extra.probeIndex ?? null,
      case: extra.case ?? null,
      limits,
    });
    return runValidationFrame({
      content,
      config,
      candidateHash,
      contractHash,
      viewport,
      signal: options.signal,
      totalTimeoutMs: limits.totalTimeoutMs,
      loadTimeoutMs: limits.loadTimeoutMs,
    });
  };
  const cancelled = (): InteractiveValidationResult => cancelledResult(
    { runId, candidateId, validationId },
    candidateHash,
    contractHash,
    '验收已取消',
  );
  const timedOut = (): InteractiveValidationResult => ({
    status: 'inconclusive',
    issues: [makeIssue(INTERACTIVE_ISSUES.validationTimeout, 'validator', 'blocking', '本次验收超出总体时间预算')],
    evidence: emptyValidationEvidence(),
    inventory: [],
    candidateHash,
    contractHash,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    validationId,
    durationMs: Date.now() - startedAt,
    cached: false,
  });

  const base = {
    candidateHash,
    contractHash,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    validationId,
    durationMs: Date.now() - startedAt,
  };
  const results: InteractiveValidationResult[] = [];
  let finalResult: InteractiveValidationResult;

  if (contract && contract.cases.length) {
    const contractIssues = contractInfo.issues;
    for (const [caseIndex, contractCase] of contract.cases.entries()) {
      if (options.signal?.aborted) return cancelled();
      if (Date.now() >= deadline) {
        results.push(timedOut());
        break;
      }
      const result = await runFrame('case', { case: contractCase }, options.viewport ?? DEFAULT_VIEWPORT, {
        readyTimeoutMs: Math.max(2500, baseLimits.readyTimeoutMs),
      });
      results.push(result);
      if (result.status === 'fail') break;
      if (caseIndex === contract.cases.length - 1) break;
    }
    finalResult = combineValidationResults(results, { ...base, durationMs: Date.now() - startedAt });
    finalResult = withExtraIssues(finalResult, contractIssues);
  } else {
    if (Date.now() >= deadline) return timedOut();
    const inspect = await runFrame('inspect', {}, options.viewport ?? DEFAULT_VIEWPORT);
    results.push(inspect);
    if (inspect.status === 'fail' || inspect.status === 'inconclusive') {
      finalResult = combineValidationResults(results, { ...base, durationMs: Date.now() - startedAt });
    } else {
      const inventory = inspect.inventory;
      if (inventory.length > MAX_PROBES) {
        results.push({
          ...inspect,
          status: 'inconclusive',
          issues: [
            ...inspect.issues,
            makeIssue(
              INTERACTIVE_ISSUES.probeCoverageTruncated,
              'validator',
              'advisory',
              `页面有 ${inventory.length} 个可操作控件，仅抽查前 ${MAX_PROBES} 个，证据不足`,
            ),
          ],
        });
      }
      const probeCount = Math.min(inventory.length, MAX_PROBES);
      for (let index = 0; index < probeCount; index += 1) {
        if (options.signal?.aborted) return cancelled();
        if (Date.now() >= deadline) {
          results.push(timedOut());
          break;
        }
        const result = await runFrame('probe', { probeIndex: index }, options.viewport ?? DEFAULT_VIEWPORT);
        results.push(result);
        if (result.status === 'fail') break;
      }
      finalResult = combineValidationResults(results, { ...base, durationMs: Date.now() - startedAt });
    }
  }

  if (finalResult.status === 'pass' && enableResponsive) {
    if (options.signal?.aborted) return cancelled();
    if (Date.now() >= deadline) return timedOut();
    const responsive = await runFrame('responsive', {}, RESPONSIVE_VIEWPORT, {
      totalTimeoutMs: Math.min(baseLimits.totalTimeoutMs, Math.max(2500, deadline - Date.now())),
      readyTimeoutMs: 2000,
      actionTimeoutMs: 2000,
    });
    finalResult = combineValidationResults([finalResult, responsive], {
      ...base,
      durationMs: Date.now() - startedAt,
    });
  }

  finalResult = {
    ...finalResult,
    candidateHash,
    contractHash,
    runtimeVersion: INTERACTIVE_RUNTIME_VERSION,
    validationId,
    durationMs: Date.now() - startedAt,
    cached: false,
  };
  if (finalResult.status === 'pass') {
    validationCache.set(cacheKey, finalResult);
    while (validationCache.size > CACHE_LIMIT) {
      const oldest = validationCache.keys().next().value;
      if (oldest === undefined) break;
      validationCache.delete(oldest);
    }
  }
  return finalResult;
}

/** 兼容旧调用点：返回三态结果而不是旧式 warnings/evidence 形状。 */
export function validateInteractiveDocument(content: string, timeoutMs = 12000): Promise<InteractiveValidationResult> {
  return validateInteractiveCandidate(content, {
    limits: { totalTimeoutMs: timeoutMs },
    overallTimeoutMs: timeoutMs + 5000,
  });
}

/* ------------------------------------------------------------------------ */
/* 生产轻量运行检查（readiness）                                            */
/* ------------------------------------------------------------------------ */

export type InteractiveReadinessStatus = 'ready' | 'failed' | 'unavailable' | 'cancelled';

export interface InteractiveReadinessLimits {
  /** iframe 加载后等待运行时就绪的上限。 */
  loadTimeoutMs: number;
  /** 首屏异步绘制（如 rAF/异步 Canvas）的有界等待预算。 */
  readyTimeoutMs: number;
  /** 首屏 DOM 初始化后的观察窗口长度。 */
  observeMs: number;
  /** 整个检查的硬上限。 */
  totalTimeoutMs: number;
}

export const READINESS_DEFAULT_LIMITS: InteractiveReadinessLimits = {
  loadTimeoutMs: 2500,
  readyTimeoutMs: 1500,
  observeMs: 800,
  totalTimeoutMs: 5000,
};

export interface InteractiveReadinessResult {
  /** ready 只表示有限窗口内页面可运行可展示，不表示完整审核通过。 */
  status: InteractiveReadinessStatus;
  /** 失败/不可用/取消时的具体首因，可直接展示给用户。 */
  reason: string;
  /** failed 时对应的结构化问题（保留首因与证据）。 */
  issue: InteractiveIssue | null;
  candidateHash: string;
  runId: string;
  checkId: string;
  durationMs: number;
}

export interface InteractiveReadinessOptions {
  signal?: AbortSignal | undefined;
  runId?: string;
  candidateId?: string;
  checkId?: string;
  candidateHash?: string;
  viewport?: { width: number; height: number };
  limits?: Partial<InteractiveReadinessLimits>;
}

function readinessResult(
  status: InteractiveReadinessStatus,
  reason: string,
  issue: InteractiveIssue | null,
  context: { candidateHash: string; runId: string; checkId: string; startedAt: number },
): InteractiveReadinessResult {
  return {
    status,
    reason,
    issue,
    candidateHash: context.candidateHash,
    runId: context.runId,
    checkId: context.checkId,
    durationMs: Date.now() - context.startedAt,
  };
}

function readinessIssueFrom(data: Record<string, unknown>): { issue: InteractiveIssue; summary: string } {
  const read = readValidationIssues(data.issues);
  const blocking = read.issues.find(issue => issue.severity === 'blocking' && !INCONCLUSIVE_ISSUE_CODES.has(issue.code))
    ?? read.issues.find(issue => issue.severity === 'blocking')
    ?? read.issues[0];
  if (blocking) return { issue: blocking, summary: typeof data.summary === 'string' ? data.summary : '' };
  return {
    issue: makeIssue(INTERACTIVE_ISSUES.emptyContent, 'candidate', 'blocking', '页面首屏没有可展示内容'),
    summary: typeof data.summary === 'string' ? data.summary : '',
  };
}

function runReadinessFrame(options: {
  content: string;
  config: InteractiveRuntimeConfig;
  candidateHash: string;
  viewport: { width: number; height: number };
  signal?: AbortSignal | undefined;
  totalTimeoutMs: number;
  loadTimeoutMs: number;
}): Promise<InteractiveReadinessResult> {
  const { config, candidateHash } = options;
  const startedAt = Date.now();
  const context = { candidateHash, runId: config.runId, checkId: config.validationId, startedAt };
  if (options.signal?.aborted) {
    return Promise.resolve(readinessResult('cancelled', '检查已取消', null, context));
  }
  return new Promise<InteractiveReadinessResult>(resolve => {
    let settled = false;
    let pageReady = false;
    let loadCount = 0;
    let malformedMessages = 0;
    let lastStage = '文档未加载';
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    const gate = new ValidationMessageGate({
      runId: config.runId,
      validationId: config.validationId,
      candidateId: config.candidateId,
    });
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${options.viewport.width}px;height:${options.viewport.height}px;opacity:0;pointer-events:none;`;
    const documentUrl = URL.createObjectURL(new Blob([buildInteractiveDocument(options.content, { testConfig: config })], { type: 'text/html' }));

    const cleanup = (): void => {
      clearTimeout(loadTimer);
      clearTimeout(absoluteTimer);
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(documentUrl);
      frame.remove();
    };
    const finish = (result: InteractiveReadinessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const unavailable = (reason: string): void => {
      finish(readinessResult('unavailable', reason, null, context));
    };
    const onAbort = (): void => {
      finish(readinessResult('cancelled', '检查已取消', null, context));
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.contentWindow) return;
      if (settled) return;
      const parsed = parseInteractiveMessage(event.data);
      if (!parsed.ok) {
        malformedMessages += 1;
        if (malformedMessages >= 8) {
          unavailable(`检查消息协议持续不匹配（${parsed.reason}），未重复执行检查`);
        }
        return;
      }
      const decision = gate.accept(parsed.message);
      if (decision.action === 'ignore') return;
      if (decision.action === 'terminal') {
        const message = decision.message;
        const data = message.data;
        if (message.type === INTERACTIVE_MESSAGE_TYPES.runtimeError) {
          const issue = makeIssue(
            INTERACTIVE_ISSUES.runtimeError,
            'runtime',
            'blocking',
            typeof data.message === 'string' ? `脚本执行失败：${data.message.slice(0, 300)}` : '脚本执行失败',
            { evidence: typeof data.diagnostics === 'string' ? data.diagnostics.slice(0, 1200) : '' },
          );
          finish(readinessResult('failed', issue.message, issue, context));
          return;
        }
        if (message.type === INTERACTIVE_MESSAGE_TYPES.readinessResult && data.status === 'ready') {
          finish(readinessResult('ready', '', null, context));
          return;
        }
        const { issue } = readinessIssueFrom(data);
        finish(readinessResult('failed', issue.message, issue, context));
        return;
      }
      const message = decision.message;
      if (message.type === INTERACTIVE_MESSAGE_TYPES.pageReady) {
        pageReady = true;
        lastStage = '页面已初始化';
        clearTimeout(loadTimer);
        return;
      }
      if (message.type === INTERACTIVE_MESSAGE_TYPES.validationProgress) {
        lastStage = typeof message.data.stage === 'string' ? message.data.stage : '检查进行中';
      }
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      loadCount += 1;
      if (loadCount > 1 && pageReady && !settled) {
        const issue = makeIssue(
          INTERACTIVE_ISSUES.navigationUnload,
          'runtime',
          'blocking',
          '页面在检查期间重新加载或导航',
          { evidence: '检查期间应保持同一文档运行；请检查是否触发页面跳转、重载或表单提交' },
        );
        finish(readinessResult('failed', issue.message, issue, context));
        return;
      }
      if (!pageReady) lastStage = '文档已加载，等待页面初始化';
    });
    frame.addEventListener('error', () => {
      unavailable('检查 iframe 加载失败');
    });
    try {
      frame.src = documentUrl;
      document.body.appendChild(frame);
    } catch (error) {
      unavailable(`无法创建检查 iframe：${error instanceof Error ? error.message : String(error)}`);
    }
    loadTimer = setTimeout(() => {
      if (settled) return;
      unavailable(pageReady ? `检查超时（${lastStage}）` : `页面加载超时（${lastStage}）`);
    }, options.loadTimeoutMs);
    absoluteTimer = setTimeout(() => {
      if (settled) return;
      unavailable(`检查超出总时限（${lastStage}）`);
    }, options.totalTimeoutMs);
  });
}

/**
 * 生产路径轻量运行检查。每个候选只创建一次检查 iframe，绝不自动操作控件。
 * 环境/加载/协议失败返回 unavailable，由调用方明确报告，不得用它修改 HTML。
 */
export async function checkInteractiveReadiness(
  content: string,
  options: InteractiveReadinessOptions = {},
): Promise<InteractiveReadinessResult> {
  const startedAt = Date.now();
  const identity = createInteractiveIdentity('readiness');
  const runId = options.runId ?? identity.runId;
  const candidateId = options.candidateId ?? identity.candidateId;
  const checkId = options.checkId ?? identity.validationId;
  const candidateHash = options.candidateHash ?? hashText(content);
  const context = { candidateHash, runId, checkId, startedAt };
  if (options.signal?.aborted) {
    return readinessResult('cancelled', '检查已取消', null, context);
  }
  if (!hasInteractiveHtmlShape(content)) {
    const issue = makeIssue(INTERACTIVE_ISSUES.emptyContent, 'candidate', 'blocking', '没有返回完整的交互 HTML');
    return readinessResult('failed', issue.message, issue, context);
  }
  const limits: InteractiveReadinessLimits = { ...READINESS_DEFAULT_LIMITS, ...options.limits };
  const config = createInteractiveRuntimeConfig({
    mode: 'readiness',
    runId,
    validationId: checkId,
    candidateId,
    limits: {
      readyTimeoutMs: limits.readyTimeoutMs,
      actionTimeoutMs: limits.readyTimeoutMs,
      settleMs: 0,
      totalTimeoutMs: limits.totalTimeoutMs,
      loadTimeoutMs: limits.loadTimeoutMs,
      firstPaintTimeoutMs: limits.readyTimeoutMs,
      observeMs: limits.observeMs,
    },
  });
  return runReadinessFrame({
    content,
    config,
    candidateHash,
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
    signal: options.signal,
    totalTimeoutMs: limits.totalTimeoutMs,
    loadTimeoutMs: limits.loadTimeoutMs,
  });
}

export { INTERACTIVE_RUNTIME_VERSION };
export type { InteractiveValidationResult, InteractiveIssue, InteractiveValidationEvidence, InteractiveControlInfo };
