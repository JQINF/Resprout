import { streamChat } from './api.js';
import { originalContextMessages } from './context-budget.js';
import { QUICK_ACTION_BOUNDARY } from './quick-actions.js';
import { validateInteractiveDocument } from './interactive-runtime.js';
import interactiveLearningStandard from './prompts/interactive-learning.md?raw';

export function buildInteractiveInstruction(topic) {
  return `请把上述对话涉及的核心内容制作成一个交互解释页面${topic ? `，重点是“${topic}”` : ''}。\n\n${interactiveLearningStandard}`;
}

function normalizeInteractiveHtml(input) {
  let text = String(input ?? '').trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = text.search(/<!doctype\s+<html|<html[\s>]|<main[\s>]|<section[\s>]|<div[\s>]|<canvas[\s>]|<svg[\s>]/i);
  if (start > 0) text = text.slice(start);
  for (const closing of ['</html>', '</main>']) {
    const end = text.toLowerCase().lastIndexOf(closing);
    if (end >= 0) {
      text = text.slice(0, end + closing.length);
      break;
    }
  }
  return text.trim();
}

export function extractInteractivePreview(output) {
  const html = normalizeInteractiveHtml(output);
  return /<(?:html|main|section|div|canvas|svg)\b/i.test(html) ? html : '';
}

async function requestText(messages, model, onDelta = null, options = {}) {
  let output = '';
  let stopReason = '';
  await streamChat(messages, event => {
    if (event.type === 'done') stopReason = event.stopReason ?? '';
    if (event.type !== 'text_delta') return;
    output += event.delta;
    onDelta?.(output);
  }, model, options);
  if (stopReason === 'length') {
    throw Object.assign(new Error('模型输出达到 token 上限，页面内容被截断'), { code: 'INTERACTIVE_OUTPUT_TRUNCATED', output });
  }
  return output;
}

async function requestHtmlText(messages, model, onDelta) {
  try {
    return await requestText(messages, model, onDelta, { purpose: 'interactive' });
  } catch (error) {
    if (error.code !== 'INTERACTIVE_OUTPUT_TRUNCATED' || !error.output) throw error;
    const partial = error.output;
    const continuationMessages = [
      ...messages,
      { role: 'assistant', content: partial },
      { role: 'user', content: '刚才的 HTML 在 token 上限处截断。请从最后一个字符之后继续，只输出剩余部分，不要重复已有内容，不要 Markdown 围栏或解释。' },
    ];
    try {
      const continuation = await requestText(continuationMessages, model, accumulated => onDelta?.(partial + accumulated), { purpose: 'interactive' });
      return partial + continuation;
    } catch (continuationError) {
      if (continuationError.code === 'INTERACTIVE_OUTPUT_TRUNCATED') {
        continuationError.output = partial + (continuationError.output ?? '');
      }
      throw continuationError;
    }
  }
}

function focusedSelectionText(messages) {
  const marker = '本次互动需要特别聚焦以下选中内容，不要偏离它：';
  const message = [...originalContextMessages(messages)].reverse().find(item => typeof item.content === 'string' && item.content.startsWith(marker));
  return message ? message.content.slice(marker.length).trim() : '';
}

function sourceText(messages) {
  return originalContextMessages(messages).filter(message => !['instruction', 'notice', 'meta'].includes(message.kind)
      && !message.content.includes(interactiveLearningStandard) && !message.content.startsWith('上一轮'))
    .map(message => message.content)
    .join('\n')
    .replaceAll(QUICK_ACTION_BOUNDARY, '');
}

function topicFor(messages) {
  return focusedSelectionText(messages)
    || originalContextMessages(messages).findLast(message => message.kind === 'task')?.content
    || '当前知识点';
}

function fallbackExplanation(messages, topic = topicFor(messages)) {
  const source = sourceText(messages).trim();
  const latest = originalContextMessages(messages).findLast(message => message.kind === 'task')?.content;
  const excerpt = (focusedSelectionText(messages) || latest || source).slice(0, 1200);
  return `### ${topic || '当前知识点'}\n\n${excerpt || '当前内容暂未生成交互解释。'}`;
}

function readableError(error) {
  const text = String(error?.message ?? error ?? '未知错误').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      const detail = value.message ?? value.error?.message ?? value.error;
      if (typeof detail === 'string') return `${text.slice(0, start).trim()} ${detail}`.trim().slice(0, 240);
    } catch {}
  }
  return text.slice(0, 240);
}

function makeDiagnostic(stage, attempts, startedAt, summary = '') {
  return { stage, attempts, summary, durationMs: Date.now() - startedAt };
}

export function fallbackInteractiveResult(messages, topic, diagnostic) {
  return {
    content: '',
    fallback: true,
    reviewStatus: 'failed',
    explanation: fallbackExplanation(messages, topic),
    diagnostic,
  };
}

function extractJsonObjects(input) {
  const values = [];
  const text = String(input ?? '').replace(/```(?:json)?/gi, '');
  let start = -1;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (string) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"' && depth) string = true;
    else if (character === '{') {
      if (!depth) start = index;
      depth += 1;
    } else if (character === '}' && depth) {
      depth -= 1;
      if (!depth) {
        try { values.push(JSON.parse(text.slice(start, index + 1))); } catch {}
      }
    }
  }
  return values;
}

async function requestHtmlReview(messages, model, content, { attempt, onAttempt, onDelta }) {
  onAttempt?.(attempt);
  const selection = focusedSelectionText(messages);
  const source = sourceText(messages);
  const excerpt = source.length > 5000 ? `${source.slice(0, 1800)}\n……\n${source.slice(-3200)}` : source;
  const contextText = `${selection ? `本次选中的内容：\n${selection}\n\n` : ''}原始对话背景：\n${excerpt}`;
  const mathNote = /数学|公式|方程|矩阵|积分|导数|几何|概率|向量|函数|计算|单位|量纲|sin|cos|tan/i.test(`${contextText}\n${content}`)
    ? '本页涉及数学或定量内容。额外核验公式、数值、单位、维度、符号、边界情况和近似表述；独立复算能够确定的初始结果及操作后的结果，不要只检查代码是否能运行。'
    : '按通用知识交互复核，不要套用数学场景或要求数学字段。';
  let output;
  try {
    output = await requestText([{
      role: 'user',
      content: `独立复核以下交互解释页面。候选 HTML 已通过沙箱运行验收。只复核内容事实与交互逻辑，不要要求固定场景、字段、控件数量或交互形式。

通用检查：
1. 页面忠实于选中内容或最新问题，没有捏造来源或无关扩展。
2. 演示逻辑自洽，控件和按钮产生真实且有解释意义的变化。
3. 初始内容完整，近似结果、模拟和动画没有被描述成严格证明。
4. 如果页面只有静态 HTML/SVG、没有可执行脚本且控件未接宿主，必须判为不通过，不能只凭外观放行。
${mathNote}

${contextText}

候选 HTML：
${content}

复核通过后，撰写简洁的右侧知识说明 Markdown，包含直观理解、核心规律、简单例子；确有必要时补充常见误区，不要复述按钮操作。

只输出一个裁决 JSON：
{"pass":true,"explanation":"Markdown 知识说明"}
或 {"pass":false,"problems":["需要修正的具体问题"]}`,
    }], model, onDelta, {
      purpose: 'interactive-review', structuredOutput: true, schema: { type: 'object' },
    });
  } catch (error) {
    error.stage = error.code === 'INTERACTIVE_OUTPUT_TRUNCATED' ? 'review' : 'provider';
    throw error;
  }
  const verdict = extractJsonObjects(output).find(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.pass === 'boolean');
  if (verdict?.pass === true) return { content, explanation: String(verdict.explanation ?? '').trim() };
  const problems = verdict?.problems?.filter(problem => typeof problem === 'string' && problem.trim()) ?? [];
  const error = new Error(problems.length ? problems.join('；') : '复核器未能给出明确结论');
  error.stage = 'review';
  throw error;
}

export async function requestInteractiveHtml(messages, model, { onDelta, onCandidate, onReview } = {}) {
  const startedAt = Date.now();
  const topic = topicFor(messages);
  let output = '';
  let issue = '';
  let stage = 'generation';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repair = attempt === 1 ? '' : `上一版在 ${stage} 阶段未通过：${issue}\n只修复相关问题，保留有效设计，重新输出完整 HTML。`;
    const requestMessages = [
      ...messages,
      { role: 'user', content: '现在根据以上标准和原始材料实现交互解释页面。自由选择合适的交互与 JavaScript 逻辑，只输出完整 HTML 片段。' },
      ...(attempt === 1 ? [] : [{ role: 'assistant', content: output }, { role: 'user', content: repair }]),
    ];
    try {
      try {
        output = normalizeInteractiveHtml(await requestHtmlText(requestMessages, model, onDelta));
      } catch (error) {
        error.stage = error.code === 'INTERACTIVE_OUTPUT_TRUNCATED' ? 'generation' : 'provider';
        throw error;
      }
      if (!/<(?:html|main|section|div|canvas|svg)\b/i.test(output)) {
        const error = new Error('没有返回完整的交互 HTML');
        error.stage = 'generation';
        throw error;
      }
      const validation = await validateInteractiveDocument(output).catch(error => {
        error.stage = 'runtime';
        throw error;
      });
      const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];

      onCandidate?.(output, makeDiagnostic('review', attempt, startedAt));
      try {
        const reviewed = await requestHtmlReview(messages, model, output, { attempt, onAttempt: onReview, onDelta });
        return {
          ...reviewed,
          fallback: false,
          reviewStatus: 'reviewed',
          diagnostic: makeDiagnostic('done', attempt, startedAt, warnings.join('；')),
        };
      } catch (error) {
        if (error.stage !== 'provider') throw error;
        return {
          content: output,
          fallback: false,
          reviewStatus: 'skipped',
          explanation: fallbackExplanation(messages, topic),
          diagnostic: makeDiagnostic('review', attempt, startedAt, [...warnings, '语义复核暂不可用，当前页面已通过运行验收'].join('；')),
        };
      }
    } catch (error) {
      if (error.stage === 'provider') {
        return fallbackInteractiveResult(messages, topic, makeDiagnostic('provider', attempt, startedAt, readableError(error)));
      }
      issue = readableError(error);
      stage = error.stage ?? 'generation';
      if (attempt === 2) {
        return fallbackInteractiveResult(messages, topic, makeDiagnostic(stage, attempt, startedAt, issue));
      }
    }
  }
  return fallbackInteractiveResult(messages, topic, makeDiagnostic(stage, 2, startedAt, issue));
}
