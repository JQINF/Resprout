export const CONTEXT_BUDGETS = {
  chat: 24000,
  interactive: 20000,
};

export function contextBudgetFor(purpose, contextWindow) {
  const fallback = CONTEXT_BUDGETS[purpose] ?? CONTEXT_BUDGETS.chat;
  const window = Number(contextWindow);
  if (!Number.isFinite(window) || window <= 0) return fallback;
  return Math.max(512, Math.floor(window * 0.65));
}

const sourceContexts = new WeakMap();

export function originalContextMessages(messages) {
  return sourceContexts.get(messages) ?? messages;
}

const REQUIRED_KINDS = new Set(['task', 'selection', 'page', 'instruction', 'image']);

function characterWeight(character) {
  if (/\s/.test(character)) return 0.25;
  return character.codePointAt(0) > 0xff ? 1 : 0.25;
}

export function estimateTextTokens(value) {
  let tokens = 0;
  for (const character of String(value ?? '')) tokens += characterWeight(character);
  return Math.ceil(tokens);
}

function messageTokens(message) {
  return estimateTextTokens(message.content) + 4;
}

function takeTokens(text, maximum, fromEnd = false) {
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

function abbreviateToTokens(value, maximum) {
  const text = String(value ?? '');
  if (estimateTextTokens(text) <= maximum) return text;
  if (maximum <= 48) return takeTokens(text, maximum);
  const available = maximum - 16;
  const head = takeTokens(text, Math.max(24, Math.floor(available * 0.6)));
  const tail = takeTokens(text, Math.max(16, Math.floor(available * 0.4)), true);
  return `${head}\n…[该段中部已省略]…\n${tail}`;
}

export function fitMessagesToBudget(messages, { budget = CONTEXT_BUDGETS.chat, recentHistory = 4 } = {}) {
  const working = messages.map((message, index) => ({
    ...message,
    index,
    content: String(message.content ?? ''),
    kind: message.kind ?? 'history',
  }));
  const contentBudget = Math.max(256, budget - 128);
  const required = working.filter(message => REQUIRED_KINDS.has(message.kind));
  const optional = working.filter(message => !REQUIRED_KINDS.has(message.kind));
  const totalOf = items => items.reduce((total, message) => total + messageTokens(message), 0);
  let requiredTruncated = 0;
  const shrinkOrder = [...required].sort((a, b) => messageTokens(b) - messageTokens(a));
  while (totalOf(required) > contentBudget) {
    const target = shrinkOrder.find(message => messageTokens(message) > 512);
    if (!target) break;
    const reduction = Math.min(totalOf(required) - contentBudget, messageTokens(target) - 512);
    target.content = abbreviateToTokens(target.content, messageTokens(target) - 4 - reduction);
    requiredTruncated += 1;
  }

  const history = optional.filter(message => message.kind === 'history');
  const recent = new Set(history.slice(-recentHistory));
  const candidates = [...optional.filter(message => message.kind === 'document'), ...history.filter(message => recent.has(message))];
  const kept = new Set(required);
  const omitted = new Set();
  for (const message of candidates) {
    const remaining = contentBudget - totalOf([...kept]);
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

  const notices = [];
  if (omitted.size) notices.push(`省略了 ${omitted.size} 条较早或低优先级材料`);
  if (requiredTruncated) notices.push(`${requiredTruncated} 条高优先级材料按头尾保留为节选`);
  const result = working.filter(message => kept.has(message));
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
