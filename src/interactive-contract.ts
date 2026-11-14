/**
 * 最小行为契约：候选页面可选地声明一组可重复、可验收的操作用例。
 *
 * 契约以 `<script type="application/json" id="resprout-test-contract">` 形式
 * 内嵌在候选 HTML 中，不执行任何代码。第一版只支持 input/select/textarea 赋值、
 * 点击和显式完成信号；不支持的动作/预期返回 inconclusive，而不是猜测页面坏了。
 * 用例允许零动作（initial-state 初态断言）：直接对初始页面执行 completion 与 expect。
 *
 * 生产发布路径不读取、不执行契约；本模块仅服务离线完整验收与诊断重放。
 * 没有契约的历史卡片走保守兼容检查，不因缺少新字段直接损坏。
 */

export const INTERACTIVE_CONTRACT_VERSION = 1;
export const MAX_CONTRACT_CASES = 8;
export const MAX_CONTRACT_ACTIONS = 12;
export const MAX_SELECTOR_LENGTH = 120;
export const MAX_CONTRACT_SOURCE_LENGTH = 24000;

export type ContractAction =
  | { type: 'set'; target: string; value: string }
  | { type: 'click'; target: string }
  | { type: 'wait'; ms: number };

export type ContractCompletion =
  | { type: 'quiet'; target: string | null; ms: number }
  | { type: 'text'; target: string; matches: string }
  | { type: 'attribute'; target: string; name: string; equals: string };

export type ContractExpectation =
  | { type: 'text'; target: string; matches: string | null; equals: string | null }
  | { type: 'changed'; target: string }
  | { type: 'unchanged'; target: string; reason: string }
  | { type: 'visible'; target: string }
  | { type: 'attribute'; target: string; name: string; equals: string };

export interface InteractiveContractCase {
  id: string;
  description: string;
  /** 用例开始时应处的状态描述（由实现声明，审核独立复核）。 */
  initialState: string;
  preconditions: string[];
  actions: ContractAction[];
  completion: ContractCompletion | null;
  expect: ContractExpectation;
  /** 合法不变状态（例如相邻取值取整后结果相同）的理由。 */
  allowNoChangeReason: string;
  /** 无法解析或暂不支持的动作/预期；非空时用例返回 inconclusive。 */
  unsupported: string[];
}

export interface InteractiveContract {
  version: number;
  cases: InteractiveContractCase[];
  sourceTruncated: boolean;
}

export type ParseInteractiveContractResult =
  | { ok: true; contract: InteractiveContract | null; issues: string[] }
  | { ok: false; reason: string };

export type ExtractInteractiveContractResult =
  | { ok: true; contract: InteractiveContract | null; issues: string[] }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSafeSelector(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const selector = value.trim();
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) return false;
  if (/[<>{}\u0000-\u001f]/.test(selector)) return false;
  if (selector.includes(',')) return false;
  return true;
}

function isSafeAttributeName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_:][-A-Za-z0-9_:.]{0,60}$/.test(value);
}

function safeRegex(source: unknown): string | null {
  const text = textValue(source);
  if (!text || text.length > 200) return null;
  try {
    new RegExp(text);
    return text;
  } catch {
    return null;
  }
}

function parseAction(value: unknown, unsupported: string[]): ContractAction | null {
  if (!isRecord(value)) {
    unsupported.push('动作不是对象');
    return null;
  }
  const type = value.type;
  if (type === 'set') {
    if (!isSafeSelector(value.target)) {
      unsupported.push('set 缺少有效 target');
      return null;
    }
    if (typeof value.value !== 'string' || value.value.length > 200) {
      unsupported.push('set 缺少有效 value');
      return null;
    }
    return { type: 'set', target: value.target.trim(), value: value.value };
  }
  if (type === 'click') {
    if (!isSafeSelector(value.target)) {
      unsupported.push('click 缺少有效 target');
      return null;
    }
    return { type: 'click', target: value.target.trim() };
  }
  if (type === 'wait') {
    const ms = Number(value.ms);
    if (!Number.isFinite(ms) || ms < 0 || ms > 2000) {
      unsupported.push('wait 时长无效');
      return null;
    }
    return { type: 'wait', ms: Math.round(ms) };
  }
  unsupported.push(`不支持的动作：${String(type)}`);
  return null;
}

function parseCompletion(value: unknown, unsupported: string[]): ContractCompletion | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    unsupported.push('完成信号不是对象');
    return null;
  }
  if (value.type === 'quiet') {
    if (value.target !== undefined && value.target !== null && !isSafeSelector(value.target)) {
      unsupported.push('quiet 的 target 无效');
      return null;
    }
    const ms = Number(value.ms ?? 150);
    if (!Number.isFinite(ms) || ms < 20 || ms > 2000) {
      unsupported.push('quiet 的等待时长无效');
      return null;
    }
    return {
      type: 'quiet',
      target: value.target ? (value.target as string).trim() : null,
      ms: Math.round(ms),
    };
  }
  if (value.type === 'text') {
    const matches = safeRegex(value.matches);
    if (!isSafeSelector(value.target) || !matches) {
      unsupported.push('text 完成信号字段无效');
      return null;
    }
    return { type: 'text', target: value.target.trim(), matches };
  }
  if (value.type === 'attribute') {
    if (!isSafeSelector(value.target) || !isSafeAttributeName(value.name) || typeof value.equals !== 'string') {
      unsupported.push('attribute 完成信号字段无效');
      return null;
    }
    return { type: 'attribute', target: value.target.trim(), name: value.name, equals: value.equals };
  }
  unsupported.push(`不支持的完成信号：${String(value.type)}`);
  return null;
}

function parseExpectation(value: unknown, unsupported: string[]): ContractExpectation | null {
  if (!isRecord(value)) {
    unsupported.push('缺少 expect 预期');
    return null;
  }
  if (value.type === 'text') {
    const matches = value.matches === undefined ? null : safeRegex(value.matches);
    const equals = typeof value.equals === 'string' ? value.equals : null;
    if (!isSafeSelector(value.target) || (!matches && equals === null)) {
      unsupported.push('text 预期字段无效');
      return null;
    }
    return { type: 'text', target: value.target.trim(), matches, equals };
  }
  if (value.type === 'changed' || value.type === 'visible') {
    if (!isSafeSelector(value.target)) {
      unsupported.push(`${String(value.type)} 预期缺少有效 target`);
      return null;
    }
    return { type: value.type, target: value.target.trim() };
  }
  if (value.type === 'unchanged') {
    if (!isSafeSelector(value.target)) {
      unsupported.push('unchanged 预期缺少有效 target');
      return null;
    }
    return {
      type: 'unchanged',
      target: value.target.trim(),
      reason: textValue(value.reason).slice(0, 300),
    };
  }
  if (value.type === 'attribute') {
    if (!isSafeSelector(value.target) || !isSafeAttributeName(value.name) || typeof value.equals !== 'string') {
      unsupported.push('attribute 预期字段无效');
      return null;
    }
    return { type: 'attribute', target: value.target.trim(), name: value.name, equals: value.equals };
  }
  unsupported.push(`不支持的预期：${String(value.type)}`);
  return null;
}

function parseCase(value: unknown, index: number, issues: string[]): InteractiveContractCase | null {
  if (!isRecord(value)) {
    issues.push(`第 ${index + 1} 个用例不是对象`);
    return null;
  }
  const id = textValue(value.id).slice(0, 80);
  if (!id) {
    issues.push(`第 ${index + 1} 个用例缺少 id`);
    return null;
  }
  const unsupported: string[] = [];
  const description = textValue(value.description).slice(0, 300);
  const initialState = textValue(value.initialState).slice(0, 300);
  const preconditions = Array.isArray(value.preconditions)
    ? value.preconditions.map(item => textValue(item).slice(0, 300)).filter(Boolean).slice(0, 8)
    : [];
  const rawActions = Array.isArray(value.actions) ? value.actions : [];
  if (rawActions.length > MAX_CONTRACT_ACTIONS) {
    issues.push(`用例 ${id} 的 actions 数量不能超过 ${MAX_CONTRACT_ACTIONS}`);
    return null;
  }
  const actions: ContractAction[] = [];
  for (const item of rawActions) {
    const action = parseAction(item, unsupported);
    if (action) actions.push(action);
  }
  const completion = parseCompletion(value.completion, unsupported);
  const expect = parseExpectation(value.expect, unsupported);
  if (!expect) {
    issues.push(`用例 ${id} 缺少可执行的预期`);
    return null;
  }
  const allowNoChangeReason = textValue(value.allowNoChangeReason).slice(0, 300);
  if (expect.type === 'unchanged' && !allowNoChangeReason && !expect.reason) {
    issues.push(`用例 ${id} 断言图形/输出不变时必须提供允许不变的理由`);
  }
  return {
    id,
    description,
    initialState,
    preconditions,
    actions,
    completion,
    expect,
    allowNoChangeReason: allowNoChangeReason || (expect.type === 'unchanged' ? expect.reason : ''),
    unsupported,
  };
}

/**
 * 本地校验契约 JSON。未知字段忽略，未知动作/预期保留在 `unsupported` 中，
 * 由运行时返回 inconclusive；结构性错误返回 `ok:false`。
 */
export function parseInteractiveContract(value: unknown): ParseInteractiveContractResult {
  if (value === null || value === undefined) return { ok: true, contract: null, issues: [] };
  if (!isRecord(value)) return { ok: false, reason: '契约不是 JSON 对象' };
  if (value.version !== INTERACTIVE_CONTRACT_VERSION) {
    return { ok: false, reason: `不支持的契约版本：${String(value.version)}` };
  }
  if (!Array.isArray(value.cases) || !value.cases.length) {
    return { ok: false, reason: '契约缺少 cases' };
  }
  const issues: string[] = [];
  const cases: InteractiveContractCase[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.cases.slice(0, MAX_CONTRACT_CASES).entries()) {
    const parsed = parseCase(item, index, issues);
    if (!parsed) continue;
    if (seen.has(parsed.id)) {
      issues.push(`用例 id 重复：${parsed.id}`);
      continue;
    }
    seen.add(parsed.id);
    cases.push(parsed);
  }
  if (value.cases.length > MAX_CONTRACT_CASES) {
    issues.push(`契约用例超过 ${MAX_CONTRACT_CASES} 个，超出部分未执行`);
  }
  if (!cases.length) return { ok: false, reason: issues[0] ?? '契约没有可用用例' };
  return {
    ok: true,
    contract: {
      version: INTERACTIVE_CONTRACT_VERSION,
      cases,
      sourceTruncated: value.cases.length > MAX_CONTRACT_CASES,
    },
    issues,
  };
}

const CONTRACT_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function attributeId(attributes: string): string {
  const match = ID_ATTRIBUTE_PATTERN.exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/** 从候选 HTML 中提取并解析契约；没有契约时返回 null。 */
export function extractInteractiveContract(html: string): ExtractInteractiveContractResult {
  const source = String(html ?? '');
  let found: string | null = null;
  let duplicates = 0;
  CONTRACT_SCRIPT_PATTERN.lastIndex = 0;
  for (let match = CONTRACT_SCRIPT_PATTERN.exec(source); match; match = CONTRACT_SCRIPT_PATTERN.exec(source)) {
    if (attributeId(match[1] ?? '') !== 'resprout-test-contract') continue;
    if (found !== null) duplicates += 1;
    else found = match[2] ?? '';
  }
  if (found === null) return { ok: true, contract: null, issues: [] };
  if (duplicates) return { ok: false, reason: '页面包含多个测试契约' };
  if (found.length > MAX_CONTRACT_SOURCE_LENGTH) return { ok: false, reason: '测试契约过大' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(found);
  } catch {
    return { ok: false, reason: '测试契约不是有效 JSON' };
  }
  return parseInteractiveContract(parsed);
}

/** 契约指纹，用于限制验收结果复用范围。 */
export function contractHash(contract: InteractiveContract | null): string {
  if (!contract) return 'none';
  return JSON.stringify(contract);
}

export function hasExecutableContract(contract: InteractiveContract | null): contract is InteractiveContract {
  return Boolean(contract && contract.cases.length);
}
