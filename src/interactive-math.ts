const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
  u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  i: 'ⁱ', n: 'ⁿ',
};

const COMMANDS: Record<string, string> = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', sim: '∼', simeq: '≃', equiv: '≡', infty: '∞',
  sum: '∑', prod: '∏', int: '∫', oint: '∮',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
  supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', partial: '∂', nabla: '∇',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
};

function mapScript(value: string, map: Record<string, string>, fallback: string): string {
  return Array.from(value).map(character => map[character] ?? fallback).join('');
}

function readableMath(input: string): string {
  let value = input.trim();
  value = value.replace(/\\(?:d?frac|tfrac)\{([^{}]+)\}\{([^{}]+)\}/g, '($1) / ($2)');
  value = value.replace(/\\sqrt\[([^\]]+)\]\{([^{}]+)\}/g, (_match, root, body) => `${mapScript(String(root), SUPERSCRIPT, '^')}√(${body})`);
  value = value.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');
  value = value.replace(/\\(?:text|mathbf|boldsymbol|mathrm|operatorname)\{([^{}]+)\}/g, '$1');
  value = value.replace(/\\([A-Za-z]+)/g, (_match, name: string) => COMMANDS[name] ?? name);
  value = value.replace(/\\(?:left|right|!|,|;|:)/g, '');
  value = value.replace(/\\s+/g, ' ');
  value = value.replace(/([A-Za-z])_(?:\{([^{}]+)\}|([A-Za-z0-9]))/g, (_match, base: string, group: string | undefined, single: string | undefined) => {
    const script = group ?? single ?? '';
    return `${base}${mapScript(script, SUBSCRIPT, `_${script}`)}`;
  });
  value = value.replace(/([A-Za-z])\^(?:\{([^{}]+)\}|([A-Za-z0-9]))/g, (_match, base: string, group: string | undefined, single: string | undefined) => {
    const script = group ?? single ?? '';
    return `${base}${mapScript(script, SUPERSCRIPT, `^${script}`)}`;
  });
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeText(text: string): string {
  return text.replace(/\$\$([^$\n]+)\$\$|\$([^$\n]+)\$/g, (_match, display: string | undefined, inline: string | undefined) => readableMath(display ?? inline ?? ''));
}

export function normalizeInteractiveMath(content: string): string {
  if (!content.includes('$') || typeof DOMParser === 'undefined') return content;
  const fullDocument = /<html[\s>]/i.test(content);
  const document = new DOMParser().parseFromString(content, 'text/html');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current.parentElement?.closest('script, style, pre, code, textarea') === null) nodes.push(current as Text);
    current = walker.nextNode();
  }
  let changed = false;
  for (const node of nodes) {
    const next = normalizeText(node.data);
    if (next === node.data) continue;
    node.data = next;
    changed = true;
  }
  if (!changed) return content;
  return fullDocument ? `<!doctype html>${document.documentElement.outerHTML}` : document.body.innerHTML;
}
