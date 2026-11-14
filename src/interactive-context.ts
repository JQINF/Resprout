/**
 * 生产流程的纯文本逻辑：消息来源提取、主题与说明降级、readiness 状态映射。
 *
 * 只依赖纯模块，可在 Node 单元测试中直接运行。提示词原文等运行期常量由调用方
 * 以参数注入（例如 sourceText 的排除片段），避免把 `?raw` 资源引入本模块。
 */

import { originalContextMessages } from './context-budget.ts';
import type { LooseMessage, PromptMessage } from './context-budget.ts';
import { QUICK_ACTION_BOUNDARY } from './quick-actions.ts';

const EXCLUDED_MESSAGE_KINDS: readonly string[] = ['instruction', 'notice', 'meta'];

export type InteractiveMessage = PromptMessage;
export type InteractiveReadinessStatus = 'ready' | 'failed' | 'unavailable' | 'cancelled';

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

export function focusedSelectionText(messages: readonly InteractiveMessage[]): string {
  const marker = '本次互动需要特别聚焦以下选中内容，不要偏离它：';
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  const message = [...context].reverse().find(item => typeof item.content === 'string' && item.content.startsWith(marker));
  return message ? message.content.slice(marker.length).trim() : '';
}

export function sourceText(messages: readonly InteractiveMessage[], excludedSnippet = ''): string {
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  return context
    .filter(message => !EXCLUDED_MESSAGE_KINDS.includes(message.kind ?? '')
      && message.kind !== 'selection'
      && !(excludedSnippet && message.content.includes(excludedSnippet))
      && !message.content.startsWith('上一轮'))
    .map(message => message.content)
    .join('\n')
    .replaceAll(QUICK_ACTION_BOUNDARY, '');
}

export function topicFor(messages: readonly InteractiveMessage[]): string {
  const context: readonly LooseMessage[] = originalContextMessages(messages);
  return focusedSelectionText(messages)
    || lastMessage(context, message => message.kind === 'task')?.content
    || '当前知识点';
}

/** 说明缺失/为空时的本地降级：只选一个来源（选区 > 最新任务 > 来源），不重复拼接。 */
export function fallbackExplanation(messages: readonly InteractiveMessage[], topic = topicFor(messages), excludedSnippet = ''): string {
  const latest = lastMessage(originalContextMessages(messages), message => message.kind === 'task')?.content;
  const source = sourceText(messages, excludedSnippet).trim();
  const excerpt = (focusedSelectionText(messages) || latest || source).slice(0, 1200);
  return `### ${topic || '当前知识点'}\n\n${excerpt || '当前内容暂未生成交互解释。'}`;
}

/** readiness 状态到存档 technicalStatus 的映射；ready 不表示完整审核通过。 */
export function readinessToTechnicalStatus(status: InteractiveReadinessStatus): 'pass' | 'fail' | 'inconclusive' {
  if (status === 'ready') return 'pass';
  if (status === 'failed') return 'fail';
  return 'inconclusive';
}
