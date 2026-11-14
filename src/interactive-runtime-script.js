(function () {
  'use strict';

  var PROTOCOL = __RESPROUT_PROTOCOL__;
  var MSG = PROTOCOL.message;
  var ISSUE = PROTOCOL.issue;
  var INCONCLUSIVE = {};
  for (var inconclusiveIndex = 0; inconclusiveIndex < PROTOCOL.inconclusiveCodes.length; inconclusiveIndex += 1) {
    INCONCLUSIVE[PROTOCOL.inconclusiveCodes[inconclusiveIndex]] = true;
  }
  var MAX_EVIDENCE_STEPS = 12;
  var MAX_INVENTORY = 24;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function now() {
    return Date.now();
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function readConfig() {
    try {
      var element = document.getElementById(PROTOCOL.testConfigElementId);
      if (!element) return null;
      var value = JSON.parse(element.textContent || 'null');
      if (!value || typeof value !== 'object' || value.mode === 'display') return null;
      return value;
    } catch (error) {
      return null;
    }
  }

  var CONFIG = readConfig();
  var TESTING = Boolean(CONFIG);

  // 离屏验收 iframe 不保证产生原生帧；页面常用 requestAnimationFrame 做首屏绘制。
  // 只在验收模式包裹 rAF：优先原生帧，同时用 32ms 计时器兜底，保证 callback 只执行一次。
  if (TESTING && typeof window.requestAnimationFrame === 'function') {
    (function () {
      var nativeRequest = window.requestAnimationFrame.bind(window);
      var nativeCancel = window.cancelAnimationFrame.bind(window);
      var entries = new Map();
      var nextId = 1;
      window.requestAnimationFrame = function (callback) {
        var id = nextId;
        nextId += 1;
        var entry = { done: false, nativeId: 0, timer: 0 };
        entries.set(id, entry);
        var finish = function (timestamp) {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(entry.timer);
          entries.delete(id);
          try { callback(timestamp); } catch (error) { recordError(error, error && error.message ? error.message : String(error), 0, 0); }
        };
        entry.timer = setTimeout(function () {
          finish(typeof performance === 'object' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());
        }, 32);
        entry.nativeId = nativeRequest(finish);
        return id;
      };
      window.cancelAnimationFrame = function (id) {
        var entry = entries.get(id);
        if (entry) {
          entry.done = true;
          clearTimeout(entry.timer);
          entries.delete(id);
          nativeCancel(entry.nativeId);
        }
      };
    })();
  }
  var LIMITS = (CONFIG && CONFIG.limits) || {
    readyTimeoutMs: 2000,
    actionTimeoutMs: 2500,
    settleMs: 120,
    totalTimeoutMs: 20000,
    loadTimeoutMs: 8000
  };

  function createStorage() {
    var values = new Map();
    return {
      get length() { return values.size; },
      clear: function () { values.clear(); },
      getItem: function (key) { return values.has(String(key)) ? values.get(String(key)) : null; },
      key: function (index) { return Array.from(values.keys())[index] || null; },
      removeItem: function (key) { values.delete(String(key)); },
      setItem: function (key, value) { values.set(String(key), String(value)); }
    };
  }
  for (var storageIndex = 0; storageIndex < 2; storageIndex += 1) {
    var storageName = storageIndex === 0 ? 'localStorage' : 'sessionStorage';
    try { Object.defineProperty(window, storageName, { configurable: true, value: createStorage() }); } catch (error) {}
  }

  var state = {};
  var viewport = { width: 0, height: 0 };
  var initialized = false;
  var validating = false;
  var finished = false;
  var startedAt = 0;
  var sequence = 0;
  var firstError = null;
  var activeAction = null;
  var issues = [];
  var evidence = {
    phase: '准备',
    initialText: '',
    steps: [],
    totalSteps: 0,
    diagnostics: '',
    inventory: []
  };

  function post(type, payload) {
    if (!TESTING) return;
    sequence += 1;
    var message = {
      protocolVersion: PROTOCOL.version,
      type: type,
      runId: CONFIG.runId,
      validationId: CONFIG.validationId,
      candidateId: CONFIG.candidateId,
      sequence: sequence
    };
    if (payload && typeof payload === 'object') {
      for (var key in payload) {
        if (hasOwn(payload, key)) message[key] = payload[key];
      }
    }
    try { window.parent.postMessage(message, '*'); } catch (error) {}
  }

  function retainedSteps() {
    if (evidence.steps.length <= MAX_EVIDENCE_STEPS) {
      return { steps: evidence.steps.slice(), omitted: 0 };
    }
    var head = evidence.steps.slice(0, 2);
    var tail = evidence.steps.slice(-(MAX_EVIDENCE_STEPS - 2));
    return { steps: head.concat(tail), omitted: evidence.steps.length - MAX_EVIDENCE_STEPS };
  }

  function snapshotEvidence(phase) {
    var retained = retainedSteps();
    return {
      phase: String(phase || evidence.phase || ''),
      initialText: String(evidence.initialText || '').slice(0, 600),
      steps: retained.steps.map(function (step, index) {
        return {
          index: index,
          control: String(step.control || '').slice(0, 180),
          action: String(step.action || '').slice(0, 180),
          before: String(step.before || '').slice(0, 120),
          after: String(step.after || '').slice(0, 120),
          text: String(step.text || '').slice(0, 500),
          changed: step.changed === true || step.domChanged === true || step.visualChanged === true,
          domChanged: step.domChanged === true,
          visualChanged: typeof step.visualChanged === 'boolean' ? step.visualChanged : null,
          waitedMs: Math.round(Number(step.waitedMs) || 0),
          issueCode: String(step.issueCode || '').slice(0, 80)
        };
      }),
      totalSteps: evidence.totalSteps,
      truncated: evidence.totalSteps > retained.steps.length,
      omittedSteps: retained.omitted,
      diagnostics: String(evidence.diagnostics || '').slice(0, 2400),
      inventory: evidence.inventory
    };
  }

  function progress(stage, index, total) {
    evidence.phase = String(stage || evidence.phase);
    post(MSG.validationProgress, {
      stage: stage,
      index: index,
      total: total,
      evidence: snapshotEvidence(stage)
    });
  }

  function addIssue(code, origin, severity, message, detail) {
    issues.push({
      code: code,
      origin: origin,
      severity: severity,
      message: String(message || code).slice(0, 600),
      evidence: String(detail || '').slice(0, 800),
      step: evidence.steps.length ? evidence.steps.length - 1 : null
    });
  }

  function statusFromIssues() {
    var failing = false;
    var inconclusive = false;
    for (var index = 0; index < issues.length; index += 1) {
      var issue = issues[index];
      if (INCONCLUSIVE[issue.code]) inconclusive = true;
      else if (issue.severity === 'blocking') failing = true;
    }
    if (failing) return 'fail';
    if (inconclusive) return 'inconclusive';
    return 'pass';
  }

  function finish(summary) {
    if (finished) return;
    finished = true;
    validating = false;
    if (!TESTING) return;
    var status = statusFromIssues();
    var terminalType = MSG.validationResult;
    if (CONFIG && CONFIG.mode === 'readiness') {
      // readiness 只描述运行可用性，不复用 pass/fail 审核语义。
      status = status === 'pass' ? 'ready' : 'failed';
      terminalType = MSG.readinessResult;
    }
    post(terminalType, {
      status: status,
      issues: issues,
      evidence: snapshotEvidence(evidence.phase),
      inventory: evidence.inventory,
      summary: String(summary || '').slice(0, 400)
    });
  }

  function finishFailure(code, message, detail) {
    if (activeAction) {
      pushStep({
        control: activeAction.control,
        action: activeAction.action,
        before: activeAction.before,
        after: activeAction.after,
        text: activeAction.text,
        changed: false,
        domChanged: false,
        visualChanged: null,
        waitedMs: 0,
        issueCode: code
      });
      activeAction = null;
    }
    addIssue(code, 'runtime', 'blocking', message, detail);
    evidence.diagnostics = String(detail || '').slice(0, 2400);
    finish(message);
  }

  function referenceExcerpt(message) {
    var match = String(message).match(/([A-Za-z_$][A-Za-z0-9_$]*) is not defined/);
    if (!match) return '';
    var identifier = match[1];
    var scripts = Array.from(document.querySelectorAll('script')).filter(function (script) {
      return script.id !== 'resprout-runtime' && script.id !== PROTOCOL.testContractElementId;
    });
    for (var index = 0; index < scripts.length; index += 1) {
      var script = scripts[index];
      var source = String(script.textContent || '');
      var position = source.indexOf(identifier);
      if (position < 0) continue;
      var newline = String.fromCharCode(10);
      var line = source.slice(0, position).split(newline).length;
      var start = Math.max(0, position - 240);
      var end = Math.min(source.length, position + identifier.length + 400);
      return '相关脚本片段（标识符 ' + identifier + '，第 ' + line + ' 行附近）：' + newline + source.slice(start, end);
    }
    return '';
  }

  function errorDiagnostics(error, message, line, column) {
    var parts = [];
    if (Number(line) > 0) parts.push('错误位置：第 ' + line + ' 行，第 ' + column + ' 列');
    var stack = String(error && error.stack ? error.stack : '').trim();
    if (stack && stack !== message) parts.push('调用栈：' + stack.slice(0, 1600));
    var excerpt = referenceExcerpt(message);
    if (excerpt) parts.push(excerpt);
    return parts.join(String.fromCharCode(10)).slice(0, 2400);
  }

  function showError(message, diagnostics) {
    message = String(message);
    var show = function () {
      if (!document.body) return;
      var notice = document.getElementById('resprout-runtime-error');
      if (!notice) {
        notice = document.createElement('div');
        notice.id = 'resprout-runtime-error';
        notice.style.cssText = 'position:fixed;right:12px;bottom:12px;left:12px;z-index:9999;padding:8px 10px;border-radius:8px;background:#fff0ee;color:#9b332a;font:12px/1.5 system-ui;box-shadow:0 2px 12px #0001';
        document.body.appendChild(notice);
      }
      notice.textContent = '交互脚本错误：' + message + (diagnostics ? String.fromCharCode(10) + String(diagnostics).slice(0, 600) : '');
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  function clearError() {
    var notice = document.getElementById('resprout-runtime-error');
    if (notice) notice.remove();
  }

  function recordError(error, message, line, column) {
    var text = String(message || (error && error.message) || '页面脚本运行失败');
    if (firstError) return firstError;
    firstError = {
      message: text.slice(0, 800),
      diagnostics: errorDiagnostics(error, text, line, column)
    };
    showError(text, firstError.diagnostics);
    if (!TESTING) {
      // 展示 iframe 没有验收身份；把具体错误转发给宿主卡片，由宿主给出重新生成入口。
      try {
        window.parent.postMessage({
          protocolVersion: PROTOCOL.version,
          type: MSG.displayError,
          message: firstError.message,
          diagnostics: firstError.diagnostics
        }, '*');
      } catch (forwardError) {}
    }
    if (validating && !finished) {
      finishFailure(ISSUE.runtimeError, '运行验收期间发生脚本错误：' + text.slice(0, 300), firstError.diagnostics);
    }
    return firstError;
  }

  function parseColor(value) {
    var match = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    var parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(function (part) { return !Number.isFinite(part); })) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function mixColors(top, bottom) {
    var alpha = Math.max(0, Math.min(1, top.a));
    return {
      r: top.r * alpha + bottom.r * (1 - alpha),
      g: top.g * alpha + bottom.g * (1 - alpha),
      b: top.b * alpha + bottom.b * (1 - alpha),
      a: 1
    };
  }

  function luminance(color) {
    var channel = function (value) {
      var normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrastRatio(first, second) {
    var a = luminance(first);
    var b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function backgroundFor(element) {
    var layers = [];
    var current = element;
    while (current) {
      var background = parseColor(getComputedStyle(current).backgroundColor);
      if (background && background.a > 0) {
        if (background.a >= 1) return background;
        layers.push(background);
      }
      current = current.parentElement;
    }
    return layers.reduceRight(function (base, layer) { return mixColors(layer, base); }, { r: 255, g: 255, b: 255, a: 1 });
  }

  function ensureContrast() {
    if (validating || typeof getComputedStyle !== 'function') return;
    document.querySelectorAll('body *:not(script):not(style):not(svg):not(canvas)').forEach(function (element) {
      if (element.namespaceURI && element.namespaceURI.indexOf('svg') >= 0) return;
      if (!isVisible(element)) return;
      var hasText = Array.from(element.childNodes || []).some(function (node) {
        return node.nodeType === 3 && String(node.textContent || '').trim();
      });
      if (!hasText) return;
      var color = parseColor(getComputedStyle(element).color);
      if (!color) return;
      var background = backgroundFor(element);
      var ratio = contrastRatio(mixColors(color, background), background);
      if (ratio >= 4.5) return;
      var dark = { r: 41, g: 58, b: 48, a: 1 };
      var white = { r: 255, g: 255, b: 255, a: 1 };
      var darkRatio = contrastRatio(dark, background);
      var whiteRatio = contrastRatio(white, background);
      if (Math.max(darkRatio, whiteRatio) > ratio) {
        element.style.color = darkRatio >= whiteRatio ? 'rgb(41, 58, 48)' : 'rgb(255, 255, 255)';
      }
    });
  }

  var contrastTimer = 0;

  function scheduleContrast() {
    if (validating || contrastTimer) return;
    contrastTimer = setTimeout(function () {
      contrastTimer = 0;
      ensureContrast();
    }, 0);
  }

  function readControl(control) {
    if (control.type === 'checkbox') return control.checked;
    if (control.type === 'range' || control.type === 'number') {
      var value = Number(control.value);
      return Number.isFinite(value) ? value : 0;
    }
    return control.value;
  }

  function syncControls() {
    document.querySelectorAll('[data-state]').forEach(function (control) {
      var key = control.dataset.state;
      if (!(key in state)) return;
      if (control.type === 'checkbox') control.checked = Boolean(state[key]);
      else if (control.value !== String(state[key])) control.value = String(state[key]);
    });
  }

  function syncText() {
    document.querySelectorAll('[data-state-text]').forEach(function (element) {
      var key = element.dataset.stateText;
      if (key in state) element.textContent = String(state[key]);
    });
  }

  function render() {
    if (!initialized) return;
    try {
      if (typeof window.renderInteractive === 'function') {
        window.renderInteractive(Object.assign({}, state), Object.assign({}, viewport));
      }
      clearError();
      scheduleContrast();
    } catch (error) {
      recordError(error, error && error.message ? error.message : String(error), 0, 0);
    }
  }

  function commit(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    Object.assign(state, patch);
    syncControls();
    syncText();
    render();
    return true;
  }
  window.interactiveSetState = commit;

  /* === 宿主绘图辅助 API（window.rsPlot） =====================================
   * observe(canvas, draw)：画布 CSS 尺寸由布局决定，缓冲区按 DPR 管理；
   * rect/clamp/pointer：坐标、标签边距与指针映射工具。 */

  function rsPlotRect(width, height, margins) {
    var m = margins || {};
    // 边距接受 left/right/top/bottom 或 l/r/t/b 两种写法。
    var left = Math.max(0, Number(m.left ?? m.l) || 0);
    var right = Math.max(0, Number(m.right ?? m.r) || 0);
    var top = Math.max(0, Number(m.top ?? m.t) || 0);
    var bottom = Math.max(0, Number(m.bottom ?? m.b) || 0);
    if (left + right >= width) { left = 0; right = 0; }
    if (top + bottom >= height) { top = 0; bottom = 0; }
    var plotWidth = Math.max(0, width - left - right);
    var plotHeight = Math.max(0, height - top - bottom);
    return {
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: plotWidth,
      height: plotHeight,
      // x/y/w/h 短别名：模型常按 r.x / r.w 使用绘图区。
      x: left,
      y: top,
      w: plotWidth,
      h: plotHeight
    };
  }

  function rsPlotClamp(value, min, max) {
    var lo = Math.min(min, max);
    var hi = Math.max(min, max);
    return Math.min(hi, Math.max(lo, value));
  }

  // 指针坐标以 canvas 自身 getBoundingClientRect 为基础，按显示宽高换算到
  // CSS 像素布局坐标；外部缩放（React Flow/浏览器）与 DPR 不会被重复乘入。
  function rsPlotPointer(canvas, event) {
    if (!canvas || !event) return null;
    var rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    var scaleX = (canvas.clientWidth || rect.width) / rect.width;
    var scaleY = (canvas.clientHeight || rect.height) / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }

  function rsObservePlot(canvas, draw) {
    if (!canvas || typeof draw !== 'function') return null;
    if (typeof canvas.getContext !== 'function') return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var disposed = false;
    var rafId = 0;
    var observer = null;
    var dprCleanup = null;
    var state = { width: 0, height: 0, dpr: 1 };

    function currentDpr() {
      var ratio = typeof window.devicePixelRatio === 'number' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1;
      return Math.max(0.5, Math.min(4, ratio));
    }

    function render() {
      if (disposed) return;
      var rect = canvas.getBoundingClientRect();
      var width = Math.max(0, Math.round(rect.width));
      var height = Math.max(0, Math.round(rect.height));
      // 零尺寸（隐藏/未布局）时延迟绘制，不产生 NaN。
      if (!width || !height) return;
      var ratio = currentDpr();
      var bufferWidth = Math.round(width * ratio);
      var bufferHeight = Math.round(height * ratio);
      // 宿主工具统一管理缓冲区；生成代码不要再自行设置 canvas.width/height。
      if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
      if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      state = { width: width, height: height, dpr: ratio };
      try {
        // 契约：draw(api)，api = { ctx, width, height, dpr, canvas }，全部使用 CSS 像素。
        draw({ ctx: ctx, width: width, height: height, dpr: ratio, canvas: canvas });
      } catch (error) {
        recordError(error, error && error.message ? error.message : String(error), 0, 0);
      }
    }

    function schedule() {
      if (disposed || rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        render();
      });
    }

    function watchDpr() {
      if (typeof window.matchMedia !== 'function') return;
      var query = window.matchMedia('(resolution: ' + currentDpr() + 'dppx)');
      var onChange = function () {
        watchDpr();
        schedule();
      };
      dprCleanup = function () {
        if (query.removeEventListener) query.removeEventListener('change', onChange);
        else if (query.removeListener) query.removeListener(onChange);
      };
      if (query.addEventListener) query.addEventListener('change', onChange, { once: true });
      else if (query.addListener) query.addListener(onChange);
    }

    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(function () { schedule(); });
      observer.observe(canvas);
    } else if (typeof window.addEventListener === 'function') {
      window.addEventListener('resize', schedule);
    }
    watchDpr();
    if (typeof document !== 'undefined' && document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(schedule).catch(function () {});
    }
    render();

    return {
      invalidate: schedule,
      redraw: render,
      state: state,
      dispose: function () {
        if (disposed) return;
        disposed = true;
        if (rafId) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
          rafId = 0;
        }
        if (observer) {
          observer.disconnect();
          observer = null;
        } else if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('resize', schedule);
        }
        if (dprCleanup) {
          dprCleanup();
          dprCleanup = null;
        }
      }
    };
  }

  window.rsPlot = {
    observe: rsObservePlot,
    rect: rsPlotRect,
    clamp: rsPlotClamp,
    pointer: rsPlotPointer
  };

  function canvasPixels(canvas) {
    var sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 64;
    var context = sample.getContext('2d');
    if (!context) return null;
    context.drawImage(canvas, 0, 0, 64, 64);
    return context.getImageData(0, 0, 64, 64).data;
  }

  function canvasHasDrawing(canvas) {
    var bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1 || canvas.width < 1 || canvas.height < 1) return true;
    try {
      var pixels = canvasPixels(canvas);
      if (!pixels) return null;
      var red = pixels[0];
      var green = pixels[1];
      var blue = pixels[2];
      var alpha = pixels[3];
      for (var index = 4; index < pixels.length; index += 4) {
        if (pixels[index] !== red || pixels[index + 1] !== green || pixels[index + 2] !== blue || pixels[index + 3] !== alpha) return true;
      }
    } catch (error) {
      return null;
    }
    return false;
  }

  function svgHasVisibleShape(svg, contentOnly) {
    var bounds = svg.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return true;
    var selector = 'path, line, polyline, polygon, rect, circle, ellipse, text';
    var roots = contentOnly ? Array.from(svg.querySelectorAll('[data-visual-content]')) : [svg];
    var elements = roots.flatMap(function (root) {
      var own = root.matches && root.matches(selector) ? [root] : [];
      return own.concat(Array.from(root.querySelectorAll(selector)));
    });
    return elements.some(function (element) {
      try {
        var box = element.getBBox();
        if (box.width <= 0 && box.height <= 0) return false;
        var current = element;
        while (current && current !== svg) {
          var style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          current = current.parentElement;
        }
        var elementStyle = getComputedStyle(element);
        var transparent = function (value) {
          return !value || value === 'none' || value === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(value);
        };
        return !(transparent(elementStyle.stroke) && transparent(elementStyle.fill));
      } catch (error) {
        return false;
      }
    });
  }

  function canvasSignature(canvas) {
    try {
      var pixels = canvasPixels(canvas);
      if (!pixels) return 0;
      var hash = 0;
      for (var index = 0; index < pixels.length; index += 4) {
        hash = (hash * 31 + pixels[index]) | 0;
        hash = (hash * 31 + pixels[index + 1]) | 0;
        hash = (hash * 31 + pixels[index + 2]) | 0;
        hash = (hash * 31 + pixels[index + 3]) | 0;
      }
      return hash;
    } catch (error) {
      return 0;
    }
  }

  function visualSignature(element, root) {
    var style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : {};
    var bounds = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    var rootBounds = root && typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
    var round = function (value) { return Math.round(value * 100) / 100; };
    var geometry = bounds ? [
      round(rootBounds ? bounds.left - rootBounds.left : 0),
      round(rootBounds ? bounds.top - rootBounds.top : 0),
      round(bounds.width),
      round(bounds.height)
    ] : [];
    return [
      style.transform,
      style.opacity,
      style.display,
      style.visibility,
      style.fill,
      style.stroke,
      style.strokeWidth,
      geometry
    ];
  }

  function graphicsSnapshot() {
    var canvases = Array.from(document.querySelectorAll('.rs-stage canvas, canvas.rs-chart')).map(function (canvas) {
      return [canvasSignature(canvas), visualSignature(canvas, null)];
    });
    var svgs = Array.from(document.querySelectorAll('.rs-stage svg, svg.rs-chart')).map(function (svg) {
      return [
        svg.outerHTML,
        visualSignature(svg, null),
        Array.from(svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse, text, g')).map(function (element) {
          return visualSignature(element, svg);
        })
      ];
    });
    return JSON.stringify([canvases, svgs]);
  }

  function visibleTextSnapshot(limit) {
    var root = document.querySelector('.rs-page') || document.body;
    return String(root && (root.innerText || root.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, limit || 1600);
  }

  function observableSnapshot() {
    return JSON.stringify([
      document.body ? document.body.innerHTML : '',
      graphicsSnapshot()
    ]);
  }

  function elementSignature(element) {
    if (!element) return '';
    var parts = [String(element.textContent || ''), String(element.outerHTML || '')];
    var canvases = element.matches && element.matches('canvas') ? [element] : [];
    canvases = canvases.concat(Array.from(element.querySelectorAll ? element.querySelectorAll('canvas') : []));
    canvases.forEach(function (canvas) {
      parts.push('canvas:' + String(canvasSignature(canvas)) + ':' + JSON.stringify(visualSignature(canvas, null)));
    });
    var svgs = element.matches && element.matches('svg') ? [element] : [];
    svgs = svgs.concat(Array.from(element.querySelectorAll ? element.querySelectorAll('svg') : []));
    svgs.forEach(function (svg) {
      parts.push('svg:' + String(svg.outerHTML || '') + ':' + JSON.stringify(visualSignature(svg, null)));
    });
    var fields = element.matches && element.matches('input, select, textarea') ? [element] : [];
    fields = fields.concat(Array.from(element.querySelectorAll ? element.querySelectorAll('input, select, textarea') : []));
    fields.forEach(function (field) {
      parts.push('field:' + String(field.value == null ? '' : field.value) + ':' + (field.checked ? '1' : '0'));
    });
    if (typeof element.getBoundingClientRect === 'function') {
      var rect = element.getBoundingClientRect();
      parts.push('rect:' + Math.round(rect.width) + 'x' + Math.round(rect.height) + '@' + Math.round(rect.left) + ',' + Math.round(rect.top));
    }
    return parts.join('|');
  }

  function hasSubmitControl(current) {
    var candidates = document.querySelectorAll("button, input[type='submit'], [data-action], [role='button']");
    for (var index = 0; index < candidates.length; index += 1) {
      var element = candidates[index];
      if (element === current) continue;
      if (element.disabled) continue;
      if (isVisible(element)) return true;
    }
    return false;
  }

  function isVisible(element) {
    if (!element) return false;
    if (typeof element.getBoundingClientRect !== 'function') return true;
    var bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 && bounds.height <= 0) return false;
    if (typeof getComputedStyle !== 'function') return true;
    var style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function initialChecks() {
    if (firstError) {
      addIssue(ISSUE.runtimeError, 'runtime', 'blocking', '页面脚本运行失败：' + firstError.message.slice(0, 300), firstError.diagnostics);
      evidence.diagnostics = firstError.diagnostics;
      return false;
    }
    var root = document.querySelector('.rs-page') || document.body;
    if (!root) {
      addIssue(ISSUE.emptyContent, 'candidate', 'blocking', '页面没有可见内容');
      return false;
    }
    var hasText = String(root.textContent || '').trim().length > 0;
    var hasContent = root.querySelector && root.querySelector('input, select, textarea, button, canvas, svg, [data-state], [data-action]');
    if (!hasText && !hasContent) {
      addIssue(ISSUE.emptyContent, 'candidate', 'blocking', '页面主区域为空');
      return false;
    }
    document.querySelectorAll('.rs-stage canvas, canvas.rs-chart').forEach(function (canvas) {
      if (!isVisible(canvas)) return;
      if (!canvas.hasAttribute('data-visual-content')) {
        addIssue(ISSUE.canvasMissingContent, 'candidate', 'blocking', '主 Canvas 缺少 data-visual-content 知识图形标记');
        return;
      }
      var drawing = canvasHasDrawing(canvas);
      if (drawing === null) {
        addIssue(ISSUE.canvasUnreadable, 'validator', 'advisory', '主 Canvas 像素无法读取，不能确认是否包含知识图形');
      } else if (!drawing) {
        addIssue(ISSUE.canvasMissingContent, 'candidate', 'blocking', '主 Canvas 没有实际绘制内容，空白画布或坐标轴不能作为核心演示');
      }
    });
    document.querySelectorAll('.rs-stage svg, svg.rs-chart').forEach(function (svg) {
      if (isVisible(svg) && !svgHasVisibleShape(svg, true)) {
        addIssue(ISSUE.svgMissingContent, 'candidate', 'blocking', '主 SVG 缺少 data-visual-content 标记的可见知识图形，坐标轴、网格和图例不算');
      }
    });
    document.querySelectorAll('[data-state-text]').forEach(function (element) {
      var key = element.dataset.stateText;
      if (!(key in state)) {
        addIssue(ISSUE.invalidOutput, 'candidate', 'blocking', '文本绑定引用了不存在的状态：' + key);
        return;
      }
      var text = String(element.textContent || '').trim();
      if (isVisible(element) && /^(?:NaN|Infinity|-Infinity|undefined)$/i.test(text)) {
        addIssue(ISSUE.invalidOutput, 'candidate', 'blocking', '文本绑定没有有效数值：' + key);
      }
    });
    document.querySelectorAll('output, .rs-output, .rs-value, .rs-badge').forEach(function (element) {
      if (!isVisible(element)) return;
      var text = String(element.textContent || '').trim();
      if (/(?:NaN|Infinity|undefined)/i.test(text)) {
        var target = element.id ? '#' + element.id + ' ' : '';
        addIssue(ISSUE.invalidOutput, 'candidate', 'blocking', '存在无效输出 ' + target + '：' + text);
      }
    });
    return !issues.some(function (issue) {
      return issue.severity === 'blocking' && !INCONCLUSIVE[issue.code];
    });
  }

  function subjectText(root) {
    if (!root || root.id === 'resprout-runtime-error') return '';
    if (root.nodeType === 1 && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(String(root.tagName))) return '';
    var text = '';
    for (var node = root.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) text += node.nodeValue;
      else if (node.nodeType === 1) text += ' ' + subjectText(node);
    }
    return text;
  }

  function readinessChecks() {
    if (firstError) {
      addIssue(ISSUE.runtimeError, 'runtime', 'blocking', '页面脚本运行失败：' + firstError.message.slice(0, 300), firstError.diagnostics);
      evidence.diagnostics = firstError.diagnostics;
      return false;
    }
    var root = document.querySelector('.rs-page') || document.body;
    if (!root) {
      addIssue(ISSUE.emptyContent, 'candidate', 'blocking', '页面没有可见内容');
      return false;
    }
    var text = String(subjectText(root) || '').replace(/\s+/g, ' ').trim();
    var hasContent = root.querySelector && root.querySelector(
      'input:not([type="hidden"]), select, textarea, button, canvas, svg, [data-state], [data-action], img, [role="img"]'
    );
    if (!text && !hasContent) {
      addIssue(ISSUE.emptyContent, 'candidate', 'blocking', '页面主区域为空或只有错误提示');
      return false;
    }
    return true;
  }

  function pageScripts() {
    return Array.from(document.querySelectorAll('script')).filter(function (script) {
      if (script.id === 'resprout-runtime') return false;
      if (script.id === PROTOCOL.testContractElementId) return false;
      return !script.type || /^(?:module|text\/javascript|application\/javascript)$/i.test(script.type);
    });
  }

  function hasPageLogic() {
    if (pageScripts().length) return true;
    if (document.querySelector('[onclick], [onchange], [oninput], [onsubmit]')) return true;
    return typeof window.renderInteractive === 'function' || typeof window.interactiveAction === 'function';
  }

  var CONTROL_SELECTOR = "input:not([type='hidden']), select, textarea, button, [data-action], [role='button']";

  function controlElements() {
    var elements = Array.from(document.querySelectorAll(CONTROL_SELECTOR));
    var seen = [];
    var result = [];
    for (var index = 0; index < elements.length; index += 1) {
      var element = elements[index];
      if (seen.indexOf(element) >= 0) continue;
      seen.push(element);
      if (element.disabled) continue;
      if (element.closest && element.closest('#resprout-runtime-error')) continue;
      if (element.hasAttribute('data-rs-skip-probe')) continue;
      if (!isVisible(element)) continue;
      result.push(element);
      if (result.length > MAX_INVENTORY) break;
    }
    return result;
  }

  function controlLabel(element, index) {
    var id = element.id ? '#' + element.id : (element.dataset && element.dataset.state ? '[data-state=' + element.dataset.state + ']' : '');
    var aria = element.getAttribute ? String(element.getAttribute('aria-label') || '').trim() : '';
    var text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    return String(element.tagName || '').toLowerCase() + id
      + '（第 ' + (index + 1) + ' / ' + controlElements().length + ' 个'
      + (aria || text ? '，' + (aria || text).slice(0, 40) : '') + '）';
  }

  function controlInfo(element, index) {
    return {
      index: index,
      tag: String(element.tagName || '').toLowerCase(),
      type: String(element.type || ''),
      label: String(element.getAttribute('aria-label') || element.textContent || element.value || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      visualControl: element.hasAttribute('data-visual-control')
    };
  }

  function nextControlValue(control) {
    if (control.type === 'checkbox') return !control.checked;
    if (control.type === 'range' || control.type === 'number') {
      var value = Number(control.value);
      var min = Number(control.min);
      var max = Number(control.max);
      if (Number.isFinite(min) && Number.isFinite(max) && min !== max) {
        var configuredStep = Number(control.step);
        var delta = Number.isFinite(configuredStep) && configuredStep > 0 ? configuredStep : Math.abs(max - min) / 10;
        var forward = value + delta;
        if (forward <= max && forward !== value) return forward;
        var backward = value - delta;
        if (backward >= min && backward !== value) return backward;
        return value === max ? min : max;
      }
      return value + 1;
    }
    if (control.tagName === 'SELECT') {
      return control.options.length > 1 ? (control.selectedIndex + 1) % control.options.length : null;
    }
    return control.value && control.value.trim() ? control.value + ' 测试' : '测试';
  }

  function writeProbeValue(control, value) {
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else if (control.tagName === 'SELECT') control.selectedIndex = value;
    else control.value = String(value);
  }

  function fireControl(control) {
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function hasActiveAnimation() {
    return typeof document.getAnimations === 'function' && document.getAnimations().length > 0;
  }

  function waitForQuiet(target, quietMs, maxMs, minMs) {
    return new Promise(function (resolve) {
      var start = now();
      var minimum = Math.max(0, Number(minMs) || 0);
      var lastMutation = now();
      var observer = null;
      try {
        observer = new MutationObserver(function () { lastMutation = now(); });
        observer.observe(target || document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true
        });
      } catch (error) {}
      var lastGraphics = graphicsSnapshot();
      var lastGraphicsAt = now();
      var timer = setInterval(function () {
        var current = now();
        var graphics = graphicsSnapshot();
        if (graphics !== lastGraphics) {
          lastGraphics = graphics;
          lastGraphicsAt = current;
        }
        var quiet = current - start >= minimum
          && current - lastMutation >= quietMs
          && current - lastGraphicsAt >= quietMs;
        if (quiet || current - start >= maxMs) {
          clearInterval(timer);
          if (observer) observer.disconnect();
          resolve({ quiet: quiet, elapsed: current - start });
        }
      }, 40);
    });
  }

  function waitWhen(predicate, timeoutMs) {
    return new Promise(function (resolve) {
      var start = now();
      var timer = setInterval(function () {
        var current = now();
        var value = false;
        try { value = predicate(); } catch (error) {}
        if (value || current - start >= timeoutMs) {
          clearInterval(timer);
          resolve({ ok: value === true, elapsed: current - start });
        }
      }, 40);
    });
  }

  function resolveTarget(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function caseTargets(caseValue) {
    if (!caseValue || !Array.isArray(caseValue.actions)) return [];
    var targets = [];
    for (var index = 0; index < caseValue.actions.length; index += 1) {
      var action = caseValue.actions[index];
      if (action && (action.type === 'set' || action.type === 'click') && typeof action.target === 'string') {
        targets.push(action.target);
      }
    }
    if (caseValue.expect && typeof caseValue.expect.target === 'string') targets.push(caseValue.expect.target);
    return targets;
  }

  function waitForReady() {
    return new Promise(function (resolve) {
      var start = now();
      var initial = observableSnapshot();
      var timer = setInterval(function () {
        var elapsed = now() - start;
        var ready = false;
        if (firstError) {
          clearInterval(timer);
          resolve({ ready: true, elapsed: elapsed });
          return;
        }
        if (CONFIG.mode === 'probe') {
          ready = controlElements().length > CONFIG.probeIndex;
        } else if (CONFIG.mode === 'case') {
          var targets = caseTargets(CONFIG.case);
          ready = targets.length === 0
            ? elapsed > 120
            : targets.every(function (selector) { return Boolean(resolveTarget(selector)); });
        } else if (CONFIG.mode === 'inspect') {
          if (controlElements().length > 0) ready = true;
          else if (!hasPageLogic()) ready = true;
          else if (elapsed > 600 && observableSnapshot() !== initial) ready = true;
        } else {
          ready = elapsed > 120;
        }
        if (ready || elapsed >= LIMITS.readyTimeoutMs) {
          clearInterval(timer);
          resolve({ ready: ready, elapsed: elapsed });
        }
      }, 40);
    });
  }

  function setControlValue(control, value) {
    if (!control) return false;
    if (control.tagName === 'SELECT') {
      var matched = false;
      for (var index = 0; index < control.options.length; index += 1) {
        if (control.options[index].value === value) {
          control.selectedIndex = index;
          matched = true;
          break;
        }
      }
      if (!matched) {
        var numeric = Number(value);
        if (Number.isInteger(numeric) && numeric >= 0 && numeric < control.options.length) {
          control.selectedIndex = numeric;
          matched = true;
        }
      }
      if (!matched) return false;
    } else if (control.type === 'checkbox' || control.type === 'radio') {
      control.checked = value === 'true' ? true : value === 'false' ? false : Boolean(value);
    } else {
      control.value = String(value);
    }
    fireControl(control);
    return true;
  }

  async function waitForCompletion(completion) {
    if (!completion) return (await waitForQuiet(null, LIMITS.settleMs, LIMITS.actionTimeoutMs, 350)).quiet;
    if (completion.type === 'quiet') {
      return (await waitForQuiet(completion.target ? resolveTarget(completion.target) : null, completion.ms, LIMITS.actionTimeoutMs)).quiet;
    }
    if (completion.type === 'text') {
      var result = await waitWhen(function () {
        var target = resolveTarget(completion.target);
        if (!target) return false;
        try {
          return new RegExp(completion.matches).test(String(target.textContent || '').trim());
        } catch (error) {
          return false;
        }
      }, LIMITS.actionTimeoutMs);
      return result.ok;
    }
    if (completion.type === 'attribute') {
      var attribute = await waitWhen(function () {
        var target = resolveTarget(completion.target);
        return Boolean(target && target.getAttribute(completion.name) === completion.equals);
      }, LIMITS.actionTimeoutMs);
      return attribute.ok;
    }
    return false;
  }

  function pushStep(step) {
    evidence.totalSteps += 1;
    evidence.steps.push(step);
  }

  function probeStep(control, index, before, beforeText, beforeGraphics, action, waitedMs) {
    var afterGraphics = graphicsSnapshot();
    var afterHtml = document.body ? document.body.innerHTML : '';
    var afterText = visibleTextSnapshot();
    var domChanged = before.html !== afterHtml;
    var textChanged = beforeText !== afterText;
    var visualChanged = beforeGraphics !== afterGraphics;
    var changed = domChanged || textChanged || visualChanged;
    var invalidInput = (typeof control.checkValidity === 'function' && !control.checkValidity())
      || (typeof control.getAttribute === 'function' && control.getAttribute('aria-invalid') === 'true');
    var step = {
      control: controlLabel(control, index),
      action: action,
      before: before.value,
      after: String(control.value || ''),
      text: afterText.slice(0, 500),
      changed: changed,
      domChanged: domChanged,
      visualChanged: visualChanged,
      waitedMs: waitedMs,
      issueCode: ''
    };
    var formControl = ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(control.tagName) >= 0
      && ['button', 'submit', 'reset'].indexOf(control.type) < 0;
    var deferredVisual = control.hasAttribute('data-visual-control') && !invalidInput && !visualChanged
      && formControl && hasSubmitControl(control);
    if (deferredVisual) {
      step.issueCode = ISSUE.visualControlDeferred;
      addIssue(ISSUE.visualControlDeferred, 'validator', 'advisory',
        '主图形控件 ' + step.control + ' 单独操作没有视觉变化，但页面存在提交按钮；可能只在提交后更新',
        '当前值 ' + step.before + ' → ' + step.after + '；请用契约验证完整提交序列');
    } else if (control.hasAttribute('data-visual-control') && !invalidInput && !visualChanged) {
      step.issueCode = ISSUE.noObservedChange;
      addIssue(ISSUE.noObservedChange, 'validator', 'advisory',
        '主图形控件 ' + step.control + ' 操作（' + action + '）前后没有实际视觉变化；缺少行为契约，无法确认该操作是否应改变图形',
        '当前值 ' + step.before + ' → ' + step.after);
    } else if (control.hasAttribute('data-visual-control') && invalidInput && !visualChanged && !textChanged) {
      step.issueCode = ISSUE.invalidInputUnverified;
      addIssue(ISSUE.invalidInputUnverified, 'validator', 'advisory',
        '无效输入控件 ' + step.control + ' 未改变主图形，也没有可见反馈；无法判断是合法保留还是缺少反馈',
        '当前值 ' + step.before + ' → ' + step.after);
    } else if (!changed) {
      step.issueCode = ISSUE.noObservedChange;
      addIssue(ISSUE.noObservedChange, 'validator', 'advisory',
        '控件 ' + step.control + ' 操作（' + action + '）后未观察到页面变化，按证据不足处理',
        '等待 ' + waitedMs + 'ms');
    }
    pushStep(step);
    return { changed: changed, step: step };
  }

  async function waitForFirstPaint() {
    await new Promise(function (resolve) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          requestAnimationFrame(finish);
        });
      }
      // 离屏 iframe 可能不产生 rAF；必须用计时器兜底，不能把首屏等待变成死锁。
      setTimeout(finish, 80);
    });
    var canvases = Array.from(document.querySelectorAll('.rs-stage canvas, canvas.rs-chart'));
    var marked = canvases.filter(function (canvas) {
      return isVisible(canvas) && canvas.hasAttribute('data-visual-content');
    });
    if (marked.length) {
      await waitWhen(function () {
        for (var index = 0; index < marked.length; index += 1) {
          if (canvasHasDrawing(marked[index]) === false) return false;
        }
        return true;
      }, Math.min(1500, LIMITS.readyTimeoutMs));
    }
    await delay(40);
  }

  async function runProbe() {
    var index = Number(CONFIG.probeIndex);
    var elements = controlElements();
    if (!Number.isInteger(index) || index < 0 || index >= elements.length) {
      addIssue(ISSUE.probeTargetMissing, 'validator', 'advisory', '验收无法重新定位第 ' + (index + 1) + ' 个控件');
      finish('控件定位不足');
      return;
    }
    var control = elements[index];
    var info = controlInfo(control, index);
    evidence.inventory = elements.map(controlInfo);
    progress('操作 ' + (info.label || info.tag), index, elements.length);
    var before = {
      html: document.body ? document.body.innerHTML : '',
      value: String(control.value || '')
    };
    var beforeText = visibleTextSnapshot();
    var beforeGraphics = graphicsSnapshot();
    var isButton = ['INPUT', 'SELECT', 'TEXTAREA'].indexOf(control.tagName) < 0
      || control.dataset.action
      || ['button', 'submit', 'reset'].indexOf(control.type) >= 0;
    var action = '点击';
    if (isButton) {
      activeAction = {
        control: controlLabel(control, index),
        action: action,
        before: before.value,
        after: String(control.value || ''),
        text: visibleTextSnapshot().slice(0, 500)
      };
      if (typeof control.click === 'function') control.click();
      else control.dispatchEvent(new Event('click', { bubbles: true }));
    } else {
      var next = nextControlValue(control);
      if (next === null) {
        addIssue(ISSUE.noObservedChange, 'validator', 'advisory', '控件 ' + info.label + ' 只有一个可选值，未执行操作');
        finish('控件不可操作');
        return;
      }
      action = '值 ' + before.value + ' → ' + String(next);
      activeAction = {
        control: controlLabel(control, index),
        action: action,
        before: before.value,
        after: String(next),
        text: visibleTextSnapshot().slice(0, 500)
      };
      writeProbeValue(control, next);
      fireControl(control);
    }
    var settled = await waitForQuiet(null, LIMITS.settleMs, LIMITS.actionTimeoutMs, 400);
    if (!settled.quiet && !firstError) {
      addIssue(ISSUE.completionTimeout, 'validator', 'advisory', '控件操作后未能确认页面稳定');
      finish('完成信号超时');
      return;
    }
    if (firstError) {
      finishFailure(ISSUE.runtimeError, '控件操作触发脚本错误：' + firstError.message.slice(0, 300), firstError.diagnostics);
      return;
    }
    if (!initialChecks()) {
      finish('操作后内容检查失败');
      return;
    }
    probeStep(control, index, before, beforeText, beforeGraphics, action, LIMITS.settleMs);
    activeAction = null;
    finish('探针完成');
  }

  async function runContractCase() {
    var caseValue = CONFIG.case;
    if (!caseValue || typeof caseValue !== 'object') {
      addIssue(ISSUE.contractInvalid, 'protocol', 'advisory', '验收运行没有收到契约用例');
      finish('契约缺失');
      return;
    }
    if (Array.isArray(caseValue.unsupported) && caseValue.unsupported.length) {
      addIssue(ISSUE.contractActionUnsupported, 'validator', 'advisory',
        '用例 ' + caseValue.id + ' 包含暂不支持的动作或预期：' + caseValue.unsupported.join('；'));
      finish('契约不支持');
      return;
    }
    if (!Array.isArray(caseValue.actions) || !caseValue.expect) {
      addIssue(ISSUE.contractInvalid, 'protocol', 'advisory', '用例 ' + String(caseValue.id || '') + ' 结构不完整');
      finish('契约无效');
      return;
    }
    var expectTarget = resolveTarget(caseValue.expect.target);
    var beforeSignature = expectTarget ? elementSignature(expectTarget) : '';
    var visualExpectation = caseValue.expect.type === 'changed' || caseValue.expect.type === 'unchanged';
    if (expectTarget && visualExpectation) {
      // 目标在用例开始时仍在变化时，无法把后续差异归因于操作；返回 inconclusive，
      // 避免循环动画让 changed 假通过或让 unchanged 假失败。
      await delay(120);
      var stableSignature = elementSignature(expectTarget);
      if (stableSignature !== beforeSignature) {
        addIssue(ISSUE.contractTargetUnstable, 'validator', 'advisory',
          '用例 ' + caseValue.id + ' 的目标在开始时仍在变化，无法判断变化是否由操作引起',
          '请让契约目标保持稳定，或改用文本/属性等确定信号');
        finish('目标不稳定');
        return;
      }
      beforeSignature = stableSignature;
    }
    var phases = ['执行用例 ' + (caseValue.id || ''), '等待完成信号', '检查预期'];
    for (var index = 0; index < caseValue.actions.length; index += 1) {
      var action = caseValue.actions[index];
      if (!action || typeof action !== 'object') {
        addIssue(ISSUE.contractInvalid, 'protocol', 'advisory', '用例动作结构不完整');
        finish('契约无效');
        return;
      }
      progress(phases[0] + '：' + (action.type || '动作'), index, caseValue.actions.length);
      if (action.type === 'wait') {
        await delay(Math.max(0, Math.min(2000, Number(action.ms) || 0)));
        continue;
      }
      var target = resolveTarget(action.target);
      if (!target) {
        addIssue(ISSUE.contractTargetMissing, 'validator', 'advisory',
          '用例 ' + caseValue.id + ' 找不到目标控件 ' + action.target);
        finish('目标控件缺失');
        return;
      }
      var beforeValue = String(target.value || '');
      var beforeText = visibleTextSnapshot();
      var beforeGraphics = graphicsSnapshot();
      activeAction = {
        control: action.target,
        action: action.type,
        before: beforeValue,
        after: beforeValue,
        text: beforeText.slice(0, 500)
      };
      if (action.type === 'set') {
        var tag = String(target.tagName || '').toUpperCase();
        if (['INPUT', 'SELECT', 'TEXTAREA'].indexOf(tag) < 0) {
          addIssue(ISSUE.contractTargetInvalid, 'validator', 'advisory', 'set 目标不是表单控件：' + action.target);
          finish('目标类型无效');
          return;
        }
        if (!setControlValue(target, String(action.value))) {
          addIssue(ISSUE.contractTargetInvalid, 'validator', 'advisory', '无法把 ' + action.target + ' 设置为期望值');
          finish('目标值无效');
          return;
        }
      } else if (action.type === 'click') {
        if (typeof target.click === 'function') target.click();
        else target.dispatchEvent(new Event('click', { bubbles: true }));
      } else {
        addIssue(ISSUE.contractActionUnsupported, 'validator', 'advisory', '不支持的动作：' + String(action.type));
        finish('动作不支持');
        return;
      }
      var settle = await waitForQuiet(null, LIMITS.settleMs, Math.min(800, LIMITS.actionTimeoutMs), 80);
      if (firstError) {
        finishFailure(ISSUE.runtimeError, '用例操作触发脚本错误：' + firstError.message.slice(0, 300), firstError.diagnostics);
        return;
      }
      var afterValue = String(target.value || '');
      var afterText = visibleTextSnapshot();
      var domChanged = beforeText !== afterText;
      var visualChanged = beforeGraphics !== graphicsSnapshot();
      pushStep({
        control: action.target,
        action: action.type === 'set' ? '值 ' + beforeValue + ' → ' + afterValue : '点击',
        before: beforeValue,
        after: afterValue,
        text: afterText.slice(0, 500),
        changed: domChanged || visualChanged,
        domChanged: domChanged,
        visualChanged: visualChanged,
        waitedMs: settle.elapsed,
        issueCode: ''
      });
      activeAction = null;
    }
    progress(phases[1], caseValue.actions.length, caseValue.actions.length);
    var completed = await waitForCompletion(caseValue.completion);
    if (firstError) {
      finishFailure(ISSUE.runtimeError, '用例操作触发脚本错误：' + firstError.message.slice(0, 300), firstError.diagnostics);
      return;
    }
    if (!completed) {
      addIssue(ISSUE.completionTimeout, 'validator', 'advisory',
        '用例 ' + caseValue.id + ' 完成后等待超时，无法确认异步计算是否结束');
      finish('完成信号超时');
      return;
    }
    if (!initialChecks()) {
      finish('操作后内容检查失败');
      return;
    }
    progress(phases[2], caseValue.actions.length, caseValue.actions.length);
    var finalTarget = resolveTarget(caseValue.expect.target);
    if (!finalTarget) {
      addIssue(ISSUE.contractTargetMissing, 'validator', 'advisory',
        '用例 ' + caseValue.id + ' 的预期目标不存在：' + caseValue.expect.target);
      finish('预期目标缺失');
      return;
    }
    var actualText = String(finalTarget.textContent || '').trim();
    var expectation = caseValue.expect;
    var passed = false;
    var detail = '';
    if (expectation.type === 'text') {
      if (expectation.matches) {
        try { passed = new RegExp(expectation.matches).test(actualText); } catch (error) { passed = false; }
        detail = '期望匹配 /' + expectation.matches + '/，实际：' + actualText.slice(0, 240);
      } else {
        passed = actualText === String(expectation.equals || '').trim();
        detail = '期望等于“' + String(expectation.equals || '') + '”，实际：' + actualText.slice(0, 240);
      }
    } else if (expectation.type === 'changed') {
      passed = Boolean(beforeSignature) && elementSignature(finalTarget) !== beforeSignature;
      detail = '期望目标发生变化，实际' + (passed ? '已变化' : '未变化');
    } else if (expectation.type === 'unchanged') {
      passed = Boolean(beforeSignature) && elementSignature(finalTarget) === beforeSignature;
      detail = '期望目标保持不变（理由：' + String(caseValue.allowNoChangeReason || '未提供') + '），实际'
        + (passed ? '未变化' : '发生变化');
    } else if (expectation.type === 'visible') {
      passed = isVisible(finalTarget);
      detail = '期望目标可见，实际' + (passed ? '满足' : '不满足');
    } else if (expectation.type === 'attribute') {
      passed = finalTarget.getAttribute(expectation.name) === expectation.equals;
      detail = '期望属性 ' + expectation.name + '=' + expectation.equals + '，实际：' + String(finalTarget.getAttribute(expectation.name));
    } else {
      addIssue(ISSUE.contractActionUnsupported, 'validator', 'advisory', '不支持的预期类型：' + String(expectation.type));
      finish('预期不支持');
      return;
    }
    if (!passed) {
      var code = expectation.type === 'unchanged' ? ISSUE.contractUnexpectedChange : ISSUE.contractExpectationUnmet;
      addIssue(code, 'candidate', 'blocking', '用例 ' + caseValue.id + ' 未满足预期', detail);
      pushStep({
        control: caseValue.expect.target,
        action: '检查预期',
        before: beforeSignature ? '已有初始快照' : '无初始快照',
        after: actualText.slice(0, 120),
        text: detail,
        changed: false,
        domChanged: false,
        visualChanged: null,
        waitedMs: 0,
        issueCode: code
      });
    }
    finish(passed ? '用例通过' : '用例未通过');
  }

  async function runInspect() {
    var elements = controlElements();
    evidence.inventory = elements.slice(0, MAX_INVENTORY).map(controlInfo);
    if (!elements.length) {
      if (!hasPageLogic()) {
        addIssue(ISSUE.noExecutableInteraction, 'candidate', 'blocking', '页面没有可执行交互逻辑，只有静态内容或控件外观');
        finish('页面没有交互逻辑');
        return;
      }
      progress('检查自动演示', 0, 1);
      var before = observableSnapshot();
      await waitForQuiet(null, LIMITS.settleMs, 800, 300);
      var after = observableSnapshot();
      if (before !== after || hasActiveAnimation()) {
        finish('自动演示可观察');
      } else {
        addIssue(ISSUE.noObservedChange, 'validator', 'advisory', '页面没有标准控件，也未观察到自动演示变化，无法确认交互');
        finish('交互证据不足');
      }
      return;
    }
    if (!hasPageLogic()) {
      addIssue(ISSUE.noExecutableInteraction, 'candidate', 'blocking', '页面只有静态控件，没有可执行脚本或事件处理');
      finish('控件没有绑定逻辑');
      return;
    }
    finish('页面可交互');
  }

  async function runReadiness() {
    // 生产轻量检查：不遍历控件、不执行契约、不要求 DOM 静止；持续动画可以通过。
    progress('等待首屏绘制', 0, 1);
    await waitForFirstPaint();
    if (finished) return;
    if (firstError) {
      finishFailure(ISSUE.runtimeError, '页面脚本运行失败：' + firstError.message.slice(0, 300), firstError.diagnostics);
      return;
    }
    evidence.initialText = visibleTextSnapshot();
    var observeMs = Math.max(200, Number(LIMITS.observeMs) || 800);
    progress('观察首屏 ' + observeMs + 'ms', 0, 1);
    await delay(observeMs);
    if (finished) return;
    var ok = readinessChecks();
    finish(ok ? '首屏可展示' : '首屏内容检查未通过');
  }

  async function runResponsive() {
    progress('检查真实窄屏布局', 0, 1);
    await waitForQuiet(null, LIMITS.settleMs, 700, 150);
    var width = window.innerWidth;
    var height = window.innerHeight;
    if (width < 2 || height < 2) {
      addIssue(ISSUE.frameError, 'validator', 'advisory', 'iframe 布局尺寸不可用');
      finish('响应式检查不可用');
      return;
    }
    var scrollWidth = Math.max(
      document.documentElement ? document.documentElement.scrollWidth : 0,
      document.body ? document.body.scrollWidth : 0
    );
    if (scrollWidth > width + 24) {
      addIssue(ISSUE.responsiveOverflow, 'candidate', 'blocking',
        '窄屏下页面横向溢出：内容宽度 ' + scrollWidth + 'px，viewport ' + width + 'px',
        '检查长标签、固定宽度和未换行内容');
    }
    var root = document.querySelector('.rs-page') || document.querySelector('.rs-panel') || document.body;
    if (root) {
      var style = getComputedStyle(root);
      var rect = root.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 80 || rect.height < 80) {
        addIssue(ISSUE.responsiveMainHidden, 'candidate', 'blocking',
          '窄屏下主内容不可见或塌陷：' + Math.round(rect.width) + '×' + Math.round(rect.height));
      }
    }
    finish('响应式检查完成');
  }

  async function runValidation() {
    if (!TESTING || finished) return;
    validating = true;
    startedAt = now();
    evidence.phase = '准备验收';
    post(MSG.validationStart, { mode: CONFIG.mode });
    try {
      if (CONFIG.mode === 'readiness') {
        await runReadiness();
        return;
      }
      var ready = await waitForReady();
      if (finished) return;
      progress('等待首屏绘制', 0, 1);
      await waitForFirstPaint();
      if (finished) return;
      evidence.initialText = visibleTextSnapshot();
      if (!initialChecks()) {
        finish('初始内容检查未通过');
        return;
      }
      if (CONFIG.mode === 'case') {
        if (!ready.ready) {
          addIssue(ISSUE.contractTargetMissing, 'validator', 'advisory', '契约用例的目标控件在等待时间内没有出现');
          finish('目标控件未就绪');
          return;
        }
        await runContractCase();
      } else if (CONFIG.mode === 'probe') {
        if (!ready.ready) {
          addIssue(ISSUE.probeTargetMissing, 'validator', 'advisory', '第 ' + (Number(CONFIG.probeIndex) + 1) + ' 个控件在等待时间内没有出现');
          finish('控件未就绪');
          return;
        }
        await runProbe();
      } else if (CONFIG.mode === 'inspect') {
        await runInspect();
      } else if (CONFIG.mode === 'readiness') {
        await runReadiness();
      } else if (CONFIG.mode === 'responsive') {
        await runResponsive();
      } else {
        finish('无需验收');
      }
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      addIssue(ISSUE.protocolViolation, 'validator', 'advisory', '验收执行异常：' + message.slice(0, 300), errorDiagnostics(error, message, 0, 0));
      evidence.diagnostics = errorDiagnostics(error, message, 0, 0);
      finish('验收执行异常');
    }
  }

  function initialize() {
    if (initialized) return;
    try {
      syncText();
      document.querySelectorAll('[data-state]').forEach(function (control) {
        var key = control.dataset.state;
        if (!key) return;
        state[key] = readControl(control);
        control.addEventListener('input', function () {
          var patch = {};
          patch[key] = readControl(control);
          commit(patch);
        });
      });
      document.querySelectorAll('[data-action]').forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.preventDefault();
          var action = button.dataset.action;
          if (typeof window.interactiveAction !== 'function') return;
          try {
            var patch = window.interactiveAction(action, Object.assign({}, state));
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              showError('动作“' + action + '”没有返回有效的状态更新');
              return;
            }
            commit(patch);
          } catch (error) {
            recordError(error, error && error.message ? error.message : String(error), 0, 0);
          }
        });
      });
      initialized = true;
      viewport = { width: window.innerWidth, height: window.innerHeight };
      render();
      ensureContrast();
      if (TESTING) {
        post(MSG.pageReady, { readyState: document.readyState, width: window.innerWidth, height: window.innerHeight });
        setTimeout(function () { runValidation(); }, 0);
      }
    } catch (error) {
      var initMessage = error && error.message ? error.message : String(error);
      recordError(error, initMessage, 0, 0);
      if (TESTING) {
        addIssue(ISSUE.runtimeError, 'runtime', 'blocking', '页面初始化失败：' + initMessage.slice(0, 300),
          firstError ? firstError.diagnostics : '');
        finish('初始化失败');
      }
    }
  }

  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== MSG.resize) return;
    viewport = {
      width: Number(event.data.width) || window.innerWidth,
      height: Number(event.data.height) || window.innerHeight
    };
    window.dispatchEvent(new Event('resize'));
    render();
  });

  document.addEventListener('input', scheduleContrast);
  document.addEventListener('change', scheduleContrast);
  document.addEventListener('click', scheduleContrast);

  window.addEventListener('pagehide', function () {
    if (!validating || finished) return;
    addIssue(ISSUE.navigationUnload, 'runtime', 'blocking', '页面在运行验收中重新加载或卸载（' + evidence.phase + '）',
      '请检查该操作是否触发页面跳转、重载、表单提交或未完成的异步等待；验收期间应保持同一文档运行。');
    finish('页面卸载');
  });

  window.addEventListener('error', function (event) {
    recordError(event.error, event.message || '页面脚本运行失败', event.lineno, event.colno);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    recordError(reason, reason && reason.message ? reason.message : String(reason), 0, 0);
  });

  post(MSG.runtimeReady, { readyState: document.readyState, hasConfig: TESTING });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
