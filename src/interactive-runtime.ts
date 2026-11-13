import { normalizeInteractiveMath } from './interactive-math.ts';

const INTERACTIVE_DESIGN_CSS = `
:root {
  --rs-bg: #f2f6f0;
  --rs-surface: #ffffff;
  --rs-text: #293a30;
  --rs-muted: #687a6d;
  --rs-accent: #527a5e;
  --rs-accent-strong: #376c49;
  --rs-border: #d5e1d4;
  --rs-soft: #edf5ee;
  --rs-warm: #eee0c4;
  color: var(--rs-text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--rs-bg);
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; }
body {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 16px;
  overflow: auto;
  background:
    radial-gradient(70% 60% at 0% 0%, rgba(210, 229, 207, 0.5), transparent 72%),
    radial-gradient(55% 50% at 100% 100%, rgba(238, 224, 196, 0.32), transparent 76%),
    var(--rs-bg);
  color: var(--rs-text);
  font-size: 14px;
  line-height: 1.65;
}
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
img, svg, canvas, video { max-width: 100%; }
::selection { color: var(--rs-text); background: #d8e8d7; }
.rs-page { display: grid; flex: 1; gap: 12px; width: 100%; max-width: none; min-height: 0; margin: 0; }
.rs-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 20px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.97), rgba(251, 253, 249, 0.93));
  box-shadow: 0 18px 42px -22px rgba(41, 67, 47, 0.22), 0 3px 10px rgba(41, 67, 47, 0.05), inset 0 1px 0 #fff;
}
.rs-title { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--rs-text); font-size: 22px; line-height: 1.3; font-weight: 700; letter-spacing: -0.02em; }
.rs-title::before { content: ''; flex: 0 0 5px; height: 22px; border-radius: 999px; background: linear-gradient(#79a77d, #47775a); box-shadow: 0 2px 5px rgba(55, 108, 73, 0.18); }
.rs-subtitle { margin: 4px 0 0 15px; color: var(--rs-accent); font-size: 12px; font-weight: 650; }
.rs-description { margin: 10px 0 0; color: var(--rs-muted); }
.rs-note { padding: 10px 12px; border: 1px solid #eadfc9; border-radius: 12px; background: linear-gradient(135deg, #fbf7ed, #f8f3e8); color: #6f6758; box-shadow: inset 0 1px 0 #fff; }
.rs-badge { display: inline-flex; align-items: center; width: max-content; padding: 3px 9px; border: 1px solid #d8e6d6; border-radius: 999px; background: linear-gradient(135deg, #f2f8ef, #e6f1e5); color: var(--rs-accent-strong); box-shadow: inset 0 1px 0 #fff; font-size: 11px; font-weight: 650; }
.rs-grid { display: grid; gap: 12px; min-width: 0; min-height: 0; }
.rs-grid-two { flex: 1; grid-template-columns: minmax(0, 1.4fr) minmax(180px, 0.8fr); align-items: stretch; min-height: 0; }
.rs-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #d8e3d6;
  border-radius: 15px;
  background:
    radial-gradient(circle at 1px 1px, rgba(82, 122, 94, 0.13) 1px, transparent 1.2px),
    linear-gradient(150deg, #fbfdf9, #f4f8f2);
  background-size: 20px 20px, 100% 100%;
  box-shadow: inset 0 1px 4px rgba(41, 67, 47, 0.05), 0 1px 0 #fff;
}
.rs-chart { position: relative; z-index: 1; display: block; width: 100%; height: clamp(160px, 38vh, 260px); min-height: 0; }
.rs-stage > .rs-chart:only-child { height: 100%; }
.rs-controls { display: grid; gap: 10px; min-width: 0; min-height: 0; overflow: auto; align-content: start; padding: 12px; border: 1px solid #dde7db; border-radius: 14px; background: rgba(247, 250, 245, 0.82); box-shadow: inset 0 1px 0 #fff; scrollbar-width: thin; }
.rs-control-list { display: grid; }
.rs-guide { padding: 10px 12px; border: 1px solid #dce7da; border-radius: 11px; background: rgba(237, 245, 238, 0.72); color: var(--rs-text); font-size: 12px; line-height: 1.6; }
.rs-guide summary { color: var(--rs-accent-strong); cursor: pointer; font-weight: 700; }
.rs-guide-goal { display: block; margin-top: 8px; font-size: 13px; }
.rs-guide ol { margin: 8px 0; padding-left: 19px; }
.rs-guide li + li { margin-top: 4px; }
.rs-guide-question { margin: 0; padding: 7px 9px; border-radius: 8px; background: #f7f2e7; color: #716650; }
.rs-guide-question span { margin-right: 6px; color: #9a784d; font-size: 11px; font-weight: 700; }
.rs-result-label { display: block; margin: 0 0 5px 2px; color: var(--rs-muted); font-size: 11px; font-weight: 650; }
.rs-reset { width: 100%; padding: 7px 12px; font-size: 12px; }
.rs-control-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.rs-control-row { display: grid; grid-template-columns: minmax(64px, auto) minmax(0, 1fr) minmax(38px, auto); align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid rgba(213, 225, 212, 0.75); }
.rs-control-row:last-child { border-bottom: 0; }
.rs-control-row .rs-field { display: block; font-size: 11px; }
.rs-control-row[data-control="a11"] .rs-field, .rs-control-row[data-control="a21"] .rs-field, .rs-control-row[data-control="x1"] .rs-field { color: #527a5e; }
.rs-control-row[data-control="a12"] .rs-field, .rs-control-row[data-control="a22"] .rs-field, .rs-control-row[data-control="x2"] .rs-field { color: #a57845; }
.rs-control-row .rs-output, .rs-control-row .rs-value { padding: 0; border: 0; background: transparent; box-shadow: none; font-size: 12px; text-align: right; }
.rs-inline { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.rs-value { color: var(--rs-accent-strong); font-weight: 700; font-variant-numeric: tabular-nums; }
.rs-field { display: grid; gap: 6px; min-width: 0; color: var(--rs-text); font-size: 12px; font-weight: 600; }
.rs-range { width: 100%; height: 18px; margin: 0; appearance: none; background: transparent; cursor: pointer; }
.rs-range::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: #d5e1d3; box-shadow: inset 0 1px 2px rgba(41, 67, 47, 0.08); }
.rs-range::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -6px; appearance: none; border: 2px solid #fff; border-radius: 50%; background: var(--rs-accent); box-shadow: 0 2px 5px rgba(41, 67, 47, 0.2); }
.rs-range::-moz-range-track { height: 4px; border-radius: 999px; background: #d5e1d3; }
.rs-range::-moz-range-thumb { width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; background: var(--rs-accent); box-shadow: 0 2px 5px rgba(41, 67, 47, 0.2); }
.rs-btn, .rs-btn-secondary { padding: 9px 14px; border-radius: 10px; cursor: pointer; font-weight: 600; transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease; }
.rs-btn { border: 1px solid #4c7e58; background: linear-gradient(145deg, #6b9872, #477a56); color: #fff; box-shadow: 0 4px 10px rgba(55, 108, 73, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.25); }
.rs-btn:hover { background: linear-gradient(145deg, #76a47d, #4c805a); box-shadow: 0 6px 14px rgba(55, 108, 73, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.3); transform: translateY(-1px); }
.rs-btn-secondary { border: 1px solid #d4e0d2; background: #fff; color: var(--rs-accent-strong); box-shadow: 0 2px 5px rgba(41, 67, 47, 0.04), inset 0 1px 0 #fff; }
.rs-btn-secondary:hover { border-color: #9db9a1; background: var(--rs-soft); }
.rs-btn:active, .rs-btn-secondary:active { transform: translateY(1px) scale(0.98); box-shadow: inset 0 2px 4px rgba(41, 67, 47, 0.12); }
.rs-btn:focus-visible, .rs-btn-secondary:focus-visible, .rs-range:focus-visible, .rs-select:focus-visible, .rs-input:focus-visible { outline: 2px solid var(--rs-accent); outline-offset: 2px; }
.rs-output { display: block; padding: 8px 11px; border: 1px solid #d8e5d7; border-radius: 10px; background: #fff; color: var(--rs-accent-strong); box-shadow: inset 0 1px 3px rgba(41, 67, 47, 0.04), 0 1px 0 #fff; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
.rs-select, .rs-input, .rs-controls select { width: 100%; padding: 8px 10px; border: 1px solid #d4e0d2; border-radius: 9px; outline: none; color: var(--rs-text); background: #fff; box-shadow: inset 0 1px 2px rgba(41, 67, 47, 0.04); }
@media (max-width: 480px) {
  .rs-panel { padding: 14px; }
  .rs-grid-two { grid-template-columns: minmax(0, 1fr); }
  .rs-title { font-size: 20px; }
  .rs-controls { padding: 0; border: 0; background: transparent; box-shadow: none; }
  .rs-control-grid { grid-template-columns: minmax(0, 1fr); }
}
`;

const INTERACTIVE_RUNTIME = `<script id="resprout-runtime">(function () {
  function createStorage() {
    const values = new Map();
    return {
      get length() { return values.size; },
      clear() { values.clear(); },
      getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
      key(index) { return Array.from(values.keys())[index] ?? null; },
      removeItem(key) { values.delete(String(key)); },
      setItem(key, value) { values.set(String(key), String(value)); },
    };
  }
  for (const name of ["localStorage", "sessionStorage"]) {
    try { Object.defineProperty(window, name, { configurable: true, value: createStorage() }); } catch {}
  }

  const state = {};
  let viewport = { width: 0, height: 0 };
  let initialized = false;

  function showError(message) {
    try { window.parent.postMessage({ type: "resprout:runtime-error", message: String(message) }, "*"); } catch {}
    const show = () => {
      if (!document.body) return;
      let notice = document.getElementById("resprout-runtime-error");
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "resprout-runtime-error";
        notice.style.cssText = "position:fixed;right:12px;bottom:12px;left:12px;z-index:9999;padding:8px 10px;border-radius:8px;background:#fff0ee;color:#9b332a;font:12px/1.5 system-ui;box-shadow:0 2px 12px #0001";
        document.body.appendChild(notice);
      }
      notice.textContent = "交互脚本错误：" + message;
    };
    if (document.body) show();
    else document.addEventListener("DOMContentLoaded", show, { once: true });
  }

  function clearError() {
    document.getElementById("resprout-runtime-error")?.remove();
  }

  let validating = false;
  let contrastTimer = 0;

  function parseColor(value) {
    const match = String(value ?? '').match(/rgba?\\(([^)]+)\\)/i);
    if (!match) return null;
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function mixColors(top, bottom) {
    const alpha = Math.max(0, Math.min(1, top.a));
    return {
      r: top.r * alpha + bottom.r * (1 - alpha),
      g: top.g * alpha + bottom.g * (1 - alpha),
      b: top.b * alpha + bottom.b * (1 - alpha),
      a: 1,
    };
  }

  function luminance(color) {
    const channel = value => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrastRatio(first, second) {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function backgroundFor(element) {
    const layers = [];
    let current = element;
    while (current) {
      const background = parseColor(getComputedStyle(current).backgroundColor);
      if (background && background.a > 0) {
        if (background.a >= 1) return background;
        layers.push(background);
      }
      current = current.parentElement;
    }
    return layers.reduceRight((base, layer) => mixColors(layer, base), { r: 255, g: 255, b: 255, a: 1 });
  }

  function ensureContrast() {
    if (validating || typeof getComputedStyle !== 'function') return;
    document.querySelectorAll('body *:not(script):not(style):not(svg):not(canvas)').forEach(element => {
      if (element.namespaceURI?.includes('svg') || !isVisible(element)) return;
      const hasText = Array.from(element.childNodes ?? []).some(node => node.nodeType === 3 && String(node.textContent ?? '').trim());
      if (!hasText) return;
      const color = parseColor(getComputedStyle(element).color);
      if (!color) return;
      const background = backgroundFor(element);
      const ratio = contrastRatio(mixColors(color, background), background);
      if (ratio >= 4.5) return;
      const dark = { r: 41, g: 58, b: 48, a: 1 };
      const white = { r: 255, g: 255, b: 255, a: 1 };
      const darkRatio = contrastRatio(dark, background);
      const whiteRatio = contrastRatio(white, background);
      if (Math.max(darkRatio, whiteRatio) > ratio) element.style.color = darkRatio >= whiteRatio ? 'rgb(41, 58, 48)' : 'rgb(255, 255, 255)';
    });
  }

  function scheduleContrast() {
    if (validating || contrastTimer) return;
    contrastTimer = setTimeout(() => {
      contrastTimer = 0;
      ensureContrast();
    }, 0);
  }

  function readControl(control) {
    if (control.type === "checkbox") return control.checked;
    if (control.type === "range" || control.type === "number") {
      const value = Number(control.value);
      return Number.isFinite(value) ? value : 0;
    }
    return control.value;
  }

  function syncControls() {
    document.querySelectorAll("[data-state]").forEach(control => {
      const key = control.dataset.state;
      if (!(key in state)) return;
      if (control.type === "checkbox") control.checked = Boolean(state[key]);
      else if (control.value !== String(state[key])) control.value = String(state[key]);
    });
  }

  function syncText() {
    document.querySelectorAll("[data-state-text]").forEach(element => {
      const key = element.dataset.stateText;
      if (key in state) element.textContent = String(state[key]);
    });
  }

  function render() {
    if (!initialized) return;
    try {
      if (typeof window.renderInteractive === "function") {
        window.renderInteractive({ ...state }, { ...viewport });
      }
      clearError();
      scheduleContrast();
    } catch (error) {
      showError(error.message || String(error));
    }
  }

  function commit(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    Object.assign(state, patch);
    syncControls();
    syncText();
    render();
    return true;
  }
  window.interactiveSetState = commit;

  function canvasPixels(canvas) {
    const sample = document.createElement("canvas");
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext("2d");
    context.drawImage(canvas, 0, 0, 64, 64);
    return context.getImageData(0, 0, 64, 64).data;
  }

  function canvasHasDrawing(canvas) {
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1 || canvas.width < 1 || canvas.height < 1) return false;
    try {
      const pixels = canvasPixels(canvas);
      const red = pixels[0];
      const green = pixels[1];
      const blue = pixels[2];
      const alpha = pixels[3];
      for (let index = 4; index < pixels.length; index += 4) {
        if (pixels[index] !== red || pixels[index + 1] !== green || pixels[index + 2] !== blue || pixels[index + 3] !== alpha) return true;
      }
    } catch {}
    return false;
  }

  function svgHasVisibleShape(svg) {
    const bounds = svg.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return false;
    return Array.from(svg.querySelectorAll("path, line, polyline, polygon, rect, circle, ellipse, text")).some(element => {
      try {
        const box = element.getBBox();
        if (box.width <= 0 && box.height <= 0) return false;
        let current = element;
        while (current && current !== svg) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
          current = current.parentElement;
        }
        const style = getComputedStyle(element);
        const transparent = value => !value || value === "none" || value === "transparent" || /^rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)$/.test(value);
        return !(transparent(style.stroke) && transparent(style.fill));
      } catch {
        return false;
      }
    });
  }

  function canvasSignature(canvas) {
    try {
      const pixels = canvasPixels(canvas);
      let hash = 0;
      for (let index = 0; index < pixels.length; index += 16) hash = (hash * 31 + pixels[index]) | 0;
      return hash;
    } catch {
      return 0;
    }
  }

  function graphicsSnapshot() {
    return JSON.stringify([
      ...Array.from(document.querySelectorAll("canvas")).map(canvasSignature),
      ...Array.from(document.querySelectorAll("svg")).map(svg => svg.innerHTML),
    ]);
  }

  function assertNoRuntimeError() {
    const notice = document.getElementById('resprout-runtime-error');
    if (notice) throw new Error(notice.textContent);
  }

  function isVisible(element) {
    if (!element) return false;
    if (typeof element.getBoundingClientRect !== 'function') return true;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 && bounds.height <= 0) return false;
    if (typeof getComputedStyle !== 'function') return true;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function assertVisibleContent() {
    const root = document.querySelector('.rs-page') ?? document.body;
    if (!root) throw new Error('页面没有可见内容');
    const hasText = String(root.textContent ?? '').trim().length > 0;
    const hasContent = root.querySelector?.('input, select, textarea, button, canvas, svg, [data-state], [data-action]');
    if (!hasText && !hasContent) throw new Error('页面主区域为空');
    document.querySelectorAll('.rs-stage canvas, canvas.rs-chart').forEach(canvas => {
      if (isVisible(canvas) && !canvasHasDrawing(canvas)) throw new Error('主图形区域没有实际绘制内容');
    });
  }

  function assertReadouts() {
    document.querySelectorAll('[data-state-text]').forEach(element => {
      const key = element.dataset.stateText;
      if (!(key in state)) throw new Error('文本绑定引用了不存在的状态：' + key);
      const text = element.textContent.trim();
      if (isVisible(element) && /^(?:NaN|Infinity|-Infinity|undefined)$/i.test(text)) {
        throw new Error('文本绑定没有有效数值：' + key);
      }
    });
    document.querySelectorAll('output, .rs-output, .rs-value, .rs-badge').forEach(element => {
      if (!isVisible(element)) return;
      const text = element.textContent.trim();
      if (/(?:NaN|Infinity|undefined)/i.test(text)) {
        const target = element.id ? '#' + element.id + ' ' : '';
        throw new Error('存在无效输出 ' + target + '：' + text);
      }
    });
  }

  function nextControlValue(control) {
    if (control.type === 'checkbox') return !control.checked;
    if (control.type === 'range' || control.type === 'number') {
      const value = Number(control.value);
      const min = Number(control.min);
      const max = Number(control.max);
      if (Number.isFinite(min) && Number.isFinite(max) && min !== max) return value === max ? min : max;
      return value + 1;
    }
    if (control.tagName === 'SELECT') {
      return control.options.length > 1 ? (control.selectedIndex + 1) % control.options.length : null;
    }
    return control.value.trim() ? control.value + ' 测试' : '测试';
  }

  function controlSnapshot(control) {
    return { value: control.value, checked: control.checked, selectedIndex: control.selectedIndex };
  }

  function writeControlValue(control, value) {
    if (control.type === 'checkbox') control.checked = value;
    else if (control.tagName === 'SELECT') control.selectedIndex = value;
    else control.value = String(value);
  }

  function restoreControl(control, snapshot) {
    control.value = snapshot.value;
    control.checked = snapshot.checked;
    control.selectedIndex = snapshot.selectedIndex;
  }

  function fireControl(control) {
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function observableSnapshot() {
    const styles = [];
    if (typeof getComputedStyle === 'function') {
      document.querySelectorAll('.rs-stage *, .rs-controls *, [data-state-text], .rs-output').forEach(element => {
        if (!isVisible(element)) return;
        const style = getComputedStyle(element);
        styles.push([style.display, style.visibility, style.opacity, style.color, style.backgroundColor, style.transform, style.width, style.height].join(','));
      });
    }
    return JSON.stringify([
      document.body?.innerHTML ?? '',
      graphicsSnapshot(),
      styles,
      typeof document.getAnimations === 'function' ? document.getAnimations().length : 0,
    ]);
  }

  function activateControl(control) {
    if (!['CANVAS', 'svg'].includes(control.tagName)) {
      control.click();
      return;
    }
    const bounds = typeof control.getBoundingClientRect === 'function'
      ? control.getBoundingClientRect()
      : { left: 0, top: 0, width: 80, height: 40 };
    const EventType = typeof PointerEvent === 'function' ? PointerEvent : Event;
    const at = (x, y) => ({ bubbles: true, clientX: bounds.left + x, clientY: bounds.top + y });
    control.dispatchEvent(new EventType('pointerdown', at(bounds.width * 0.4, bounds.height * 0.5)));
    control.dispatchEvent(new EventType('pointermove', at(bounds.width * 0.7, bounds.height * 0.6)));
    control.dispatchEvent(new EventType('pointerup', at(bounds.width * 0.7, bounds.height * 0.6)));
    if (typeof control.click === 'function') control.click();
    else control.dispatchEvent(new Event('click', { bubbles: true }));
  }

  function hasActiveAnimation() {
    return typeof document.getAnimations === 'function' && document.getAnimations().length > 0;
  }

  async function validateInteractive() {
    validating = true;
    try { window.parent.postMessage({ type: 'resprout:validation-start' }, '*'); } catch {}
    try {
      assertNoRuntimeError();
      assertVisibleContent();
      assertReadouts();
      const warnings = [];
      const controls = Array.from(document.querySelectorAll("input:not([type='hidden']), select, textarea, button, [data-action], [role='button'], [tabindex], [onclick], .rs-stage canvas, .rs-stage svg"))
        .filter((control, index, all) => all.indexOf(control) === index && !control.disabled && isVisible(control));
      const savedState = { ...state };
      const savedControls = controls.map(controlSnapshot);
      let hasObservableChange = false;
      if (!controls.length) {
        const before = observableSnapshot();
        await new Promise(resolve => setTimeout(resolve, 120));
        hasObservableChange = before !== observableSnapshot() || hasActiveAnimation();
        if (!hasObservableChange) warnings.push('未检测到标准控件或自动演示，请手动确认页面交互');
      }
      for (const control of controls) {
        const before = observableSnapshot();
        const isButton = !['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName)
          || control.dataset.action || ['button', 'submit', 'reset'].includes(control.type);
        if (isButton) {
          activateControl(control);
        } else {
          const next = nextControlValue(control);
          if (next === null) continue;
          writeControlValue(control, next);
          fireControl(control);
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        assertNoRuntimeError();
        assertVisibleContent();
        assertReadouts();
        const key = control.dataset.state;
        if (key && state[key] !== readControl(control)) throw new Error('控件没有正确更新状态：' + key);
        if (before !== observableSnapshot()) hasObservableChange = true;
      }
      if (!hasObservableChange) {
        const before = observableSnapshot();
        await new Promise(resolve => setTimeout(resolve, 80));
        hasObservableChange = before !== observableSnapshot() || hasActiveAnimation();
      }
      if (!hasObservableChange) {
        const hasPageScript = Array.from(document.querySelectorAll('script')).some(script => {
          if (script.id === 'resprout-runtime') return false;
          return !script.type || /^(?:module|text\\/javascript|application\\/javascript)$/i.test(script.type);
        });
        const hasHostInteraction = typeof window.renderInteractive === 'function' || typeof window.interactiveAction === 'function';
        if (!hasPageScript && !hasHostInteraction) throw new Error('页面没有可执行交互逻辑，只有静态内容或控件外观');
        warnings.push('自动验收未检测到页面变化，请手动确认交互');
      }
      controls.forEach((control, index) => {
        restoreControl(control, savedControls[index]);
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName) && !['button', 'submit', 'reset'].includes(control.type)) fireControl(control);
      });
      commit(savedState);
      const previousViewport = { ...viewport };
      viewport = { width: Math.min(640, previousViewport.width || 640), height: Math.min(480, previousViewport.height || 480) };
      window.dispatchEvent(new Event('resize'));
      render();
      assertNoRuntimeError();
      assertVisibleContent();
      assertReadouts();
      viewport = previousViewport;
      window.dispatchEvent(new Event('resize'));
      render();
      assertNoRuntimeError();
      assertVisibleContent();
      validating = false;
      ensureContrast();
      try { window.parent.postMessage({ type: 'resprout:validation', ok: true, warnings }, '*'); } catch {}
    } catch (error) {
      validating = false;
      showError(error.message || String(error));
    }
  }

  function initialize() {
    if (initialized) return;
    try { window.parent.postMessage({ type: "resprout:runtime-ready" }, "*"); } catch {}
    viewport = { width: window.innerWidth, height: window.innerHeight };
    document.querySelectorAll("[data-state]").forEach(control => {
      const key = control.dataset.state;
      if (!key) return;
      state[key] = readControl(control);
      control.addEventListener("input", () => {
        const patch = {};
        patch[key] = readControl(control);
        commit(patch);
      });
    });
    document.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const action = button.dataset.action;
        if (typeof window.interactiveAction !== "function") return;
        try {
          const patch = window.interactiveAction(action, { ...state });
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            showError("动作“" + action + "”没有返回有效的状态更新");
            return;
          }
          commit(patch);
        } catch (error) {
          showError(error.message || String(error));
        }
      });
    });
    initialized = true;
    syncText();
    render();
    ensureContrast();
    setTimeout(validateInteractive, 0);
  }

  window.addEventListener("message", event => {
    if (event.data?.type !== "resprout:resize") return;
    viewport = {
      width: Number(event.data.width) || window.innerWidth,
      height: Number(event.data.height) || window.innerHeight,
    };
    window.dispatchEvent(new Event("resize"));
    render();
  });
  document.addEventListener("input", scheduleContrast);
  document.addEventListener("change", scheduleContrast);
  document.addEventListener("click", scheduleContrast);
  window.addEventListener("error", event => showError(event.message || "页面脚本运行失败"));
  window.addEventListener("unhandledrejection", event => showError(event.reason?.message || String(event.reason)));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();</script>`;

const INTERACTIVE_METADATA = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${INTERACTIVE_RUNTIME}`;
const INTERACTIVE_STYLES = `<style>${INTERACTIVE_DESIGN_CSS}</style>`;

export interface InteractiveValidationResult {
  valid: true;
  warnings: string[];
}

type RuntimeMessageRecord = Record<string, unknown>;

export type InteractiveRuntimeMessage = RuntimeMessageRecord & (
  | { type: 'resprout:runtime-error'; message?: unknown }
  | { type: 'resprout:validation'; ok?: unknown; warnings?: unknown }
  | { type: 'resprout:validation-start' }
  | { type: 'resprout:runtime-ready' }
);

type InteractiveRuntimeMessageType = InteractiveRuntimeMessage['type'];

const RUNTIME_MESSAGE_TYPES: ReadonlySet<string> = new Set<InteractiveRuntimeMessageType>([
  'resprout:runtime-error',
  'resprout:validation',
  'resprout:validation-start',
  'resprout:runtime-ready',
]);

function runtimeMessageRecord(value: unknown): RuntimeMessageRecord | null {
  return typeof value === 'object' && value !== null ? value as RuntimeMessageRecord : null;
}

function isRuntimeMessageType(value: unknown): value is InteractiveRuntimeMessageType {
  return typeof value === 'string' && RUNTIME_MESSAGE_TYPES.has(value);
}

function asInteractiveRuntimeMessage(value: unknown): InteractiveRuntimeMessage | null {
  const record = runtimeMessageRecord(value);
  return record && isRuntimeMessageType(record.type) ? record as InteractiveRuntimeMessage : null;
}

export function buildInteractiveDocument(content: string): string {
  content = normalizeInteractiveMath(String(content ?? ''));
  if (/<html[\s>]/i.test(content)) {
    if (/<head[^>]*>/i.test(content)) {
      const withRuntime = content.replace(/<head[^>]*>/i, match => `${match}${INTERACTIVE_METADATA}`);
      if (/<\/head>/i.test(withRuntime)) return withRuntime.replace(/<\/head>/i, `${INTERACTIVE_STYLES}</head>`);
      return withRuntime;
    }
    return content.replace(/<html[^>]*>/i, match => `${match}<head>${INTERACTIVE_METADATA}${INTERACTIVE_STYLES}</head>`);
  }
  return `<!doctype html><html><head>${INTERACTIVE_METADATA}${INTERACTIVE_STYLES}</head><body>${content}</body></html>`;
}

export function validateInteractiveDocument(content: string, timeoutMs = 12000): Promise<InteractiveValidationResult> {
  return new Promise<InteractiveValidationResult>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;height:640px;opacity:0;pointer-events:none;';
    const documentUrl = URL.createObjectURL(new Blob([buildInteractiveDocument(content)], { type: 'text/html' }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastEvent = '文档未加载';
    const armTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(`交互运行验收超时（${lastEvent}）`), timeoutMs);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      URL.revokeObjectURL(documentUrl);
      window.removeEventListener('message', onMessage);
      frame.remove();
    };
    const fail = (message: string): void => {
      cleanup();
      reject(new Error(message));
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      const data = asInteractiveRuntimeMessage(event.data);
      const rawType = runtimeMessageRecord(event.data)?.type;
      lastEvent = rawType != null ? String(rawType) : '收到未知消息';
      if (event.source && event.source !== frame.contentWindow) return;
      if (data?.type === 'resprout:runtime-error') {
        const message = data.message;
        fail(message ? String(message) : '交互运行失败');
      } else if (data?.type === 'resprout:validation' && data.ok) {
        const warnings = Array.isArray(data.warnings)
          ? data.warnings.filter((item): item is string => typeof item === 'string')
          : [];
        cleanup();
        resolve({ valid: true, warnings });
      }
    };
    window.addEventListener('message', onMessage);
    frame.addEventListener('load', () => {
      lastEvent = '文档已加载，等待运行消息';
      armTimer();
    });
    frame.addEventListener('error', () => {
      lastEvent = '文档加载失败';
      armTimer();
    });
    armTimer();
    frame.src = documentUrl;
    document.body.appendChild(frame);
  });
}
