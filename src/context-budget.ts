export type ContextMessageKind =
  | 'task'
  | 'history'
  | 'selection'
  | 'instruction'
  | 'image'
  | 'document'
  | 'notice'
  | 'meta'
  | 'page';

export interface LooseMessage {
  role: string;
  content: string;
  kind?: string;
  assetId?: string | null;
}

export interface PromptMessage extends LooseMessage {
  role: 'user' | 'assistant';
  content: string;
  kind?: ContextMessageKind;
  assetId?: string;
}

export interface ContextMessage extends PromptMessage {
  kind: ContextMessageKind;
  index?: number;
}

export interface FitMessagesOptions {
  budget?: number;
  recentHistory?: number;
}

export const CONTEXT_BUDGETS = {
  chat: 24000,
  interactive: 20000,
} as const;

type ContextPurpose = keyof typeof CONTEXT_BUDGETS;

function isContextPurpose(value: string): value is ContextPurpose {
  return value === 'chat' || value === 'interactive';
}

export function contextBudgetFor(purpose: string, contextWindow?: number | null): number {
  const fallback = isContextPurpose(purpose) ? CONTEXT_BUDGETS[purpose] : CONTEXT_BUDGETS.chat;
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return fallback;
  return Math.max(512, Math.floor(window * 0.65));
}

const sourceContexts = new WeakMap<readonly LooseMessage[], readonly PromptMessage[]>();

export function originalContextMessages(messages: readonly PromptMessage[]): PromptMessage[];
export function originalContextMessages(messages: readonly LooseMessage[]): LooseMessage[];
export function originalContextMessages(messages: readonly LooseMessage[]): LooseMessage[] {
  const source: readonly LooseMessage[] = sourceContexts.get(messages) ?? messages;
  return [...source];
}

const REQUIRED_KINDS: ReadonlySet<string> = new Set(['task', 'selection', 'page', 'instruction', 'image']);

function characterWeight(character: string): number {
  if (/\s/.test(character)) return 0.25;
  return (character.codePointAt(0) ?? 0) > 0xff ? 1 : 0.25;
}

export function estimateTextTokens(value: unknown): number {
  let tokens = 0;
  for (const character of String(value ?? '')) tokens += characterWeight(character);
  return Math.ceil(tokens);
}

function messageTokens(message: Pick<PromptMessage, 'content'>): number {
  return estimateTextTokens(message.content) + 4;
}

function takeTokens(text: string, maximum: number, fromEnd = false): string {
  const characters = fromEnd ? [...text].reverse() : [...text];
  let tokens = 0;
  let result = '';
  for (const character of characters) {
    const weight = characterWeight(character);
    if (tokens + weight > maximum) break;
    tokens += weight;
    result += character;
  }
  return fromEnd ? [...result].reverse().join('') : result;
}

function abbreviateToTokens(value: unknown, maximum: number): string {
  const text = String(value ?? '');
  if (estimateTextTokens(text) <= maximum) return text;
  if (maximum <= 48) return takeTokens(text, maximum);
  const available = maximum - 16;
  const head = takeTokens(text, Math.max(24, Math.floor(available * 0.6)));
  const tail = takeTokens(text, Math.max(16, Math.floor(available * 0.4)), true);
  return `${head}\n…[该段中部已省略]…\n${tail}`;
}

function totalTokensOf(items: readonly PromptMessage[]): number {
  return items.reduce((total, message) => total + messageTokens(message), 0);
}

export function fitMessagesToBudget(
  messages: readonly PromptMessage[],
  { budget = CONTEXT_BUDGETS.chat, recentHistory = 4 }: FitMessagesOptions = {},
): ContextMessage[] {
  const working: ContextMessage[] = messages.map((message, index) => ({
    ...message,
    index,
    content: String(message.content ?? ''),
    kind: message.kind ?? 'history',
  }));
  const contentBudget = Math.max(256, budget - 128);
  const required = working.filter(message => REQUIRED_KINDS.has(message.kind));
  const optional = working.filter(message => !REQUIRED_KINDS.has(message.kind));
  let requiredTruncated = 0;
  const shrinkOrder = [...required].sort((a, b) => messageTokens(b) - messageTokens(a));
  while (totalTokensOf(required) > contentBudget) {
    const target = shrinkOrder.find(message => messageTokens(message) > 512);
    if (!target) break;
    const reduction = Math.min(totalTokensOf(required) - contentBudget, messageTokens(target) - 512);
    target.content = abbreviateToTokens(target.content, messageTokens(target) - 4 - reduction);
    requiredTruncated += 1;
  }

  const history = optional.filter(message => message.kind === 'history');
  const recent = new Set(history.slice(-recentHistory));
  const candidates = [
    ...optional.filter(message => message.kind === 'document'),
    ...history.filter(message => recent.has(message)),
  ];
  const kept = new Set<ContextMessage>(required);
  const omitted = new Set<ContextMessage>();
  for (const message of candidates) {
    const remaining = contentBudget - totalTokensOf([...kept]);
    if (remaining >= messageTokens(message)) {
      kept.add(message);
    } else if (remaining >= 768) {
      message.content = abbreviateToTokens(message.content, remaining - 4);
      kept.add(message);
    } else {
      omitted.add(message);
    }
  }
  for (const message of optional) if (!kept.has(message)) omitted.add(message);

  const notices: string[] = [];
  if (omitted.size) notices.push(`省略了 ${omitted.size} 条较早或低优先级材料`);
  if (requiredTruncated) notices.push(`${requiredTruncated} 条高优先级材料按头尾保留为节选`);
  const result: ContextMessage[] = working.filter(message => kept.has(message));
  if (notices.length) {
    result.unshift({
      role: 'user',
      kind: 'notice',
      content: `上下文管理说明：${notices.join('；')}。当前任务、选中原文和最近上下文优先保留。`,
    });
  }
  sourceContexts.set(result, messages);
  return result;
}
