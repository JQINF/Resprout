import { readFile } from 'node:fs/promises';
import { buildDocument } from '../src/interactive-document.ts';
import { CdpConnection, launchBrowser, openPage } from './interactive-browser-cdp.ts';
import type { PreviewObservationInput, PreviewState, PreviewViewport } from './interactive-agent-state.ts';

const DEFAULT_VIEWPORT: PreviewViewport = { width: 900, height: 600 };

function waitDuration(value: string): number {
  if (!value.trim()) throw new Error('wait 必须提供 0–2000 毫秒的整数');
  const duration = Number(value);
  if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0 || duration > 2000) throw new Error('wait 必须是 0–2000 毫秒的有限整数');
  return duration;
}

async function readRuntimeSource(): Promise<string> {
  try {
    const source = await readFile(new URL('../src/interactive-runtime-script.ts', import.meta.url), 'utf8');
    const { transformWithOxc } = await import('vite');
    const filename = new URL('../src/interactive-runtime-script.ts', import.meta.url).pathname;
    return (await transformWithOxc(source, filename, { lang: 'ts' })).code;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  return readFile(new URL('../src/interactive-runtime-script.js', import.meta.url), 'utf8');
}

/** No shell, filesystem or arbitrary CDP commands are exposed to the model. */
export async function createInteractivePreview(signal: AbortSignal) {
  const browser = await launchBrowser();
  let cdp: CdpConnection | undefined;
  const stop = () => { cdp?.close(); void browser.close(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    cdp = await CdpConnection.connect(browser.wsUrl);
    const connection = cdp;
    const page = await openPage(connection);
    await connection.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }, { urlPattern: 'file://*' }] }, page.sessionId);
    connection.on('Fetch.requestPaused', (event, session) => {
      if (session) void connection.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, session).catch(() => {});
    });
    const navigationErrors: string[] = [];
    connection.on('Page.frameNavigated', (event) => {
      const frame = event.frame as { parentId?: string; url?: string };
      if (frame.parentId && frame.url !== 'about:srcdoc') navigationErrors.push('预览页面发生导航：' + frame.url);
    });
    const contexts = new Map<string, { id: number; frame: string; session: string }>();
    connection.on('Target.attachedToTarget', event => {
      const session = String(event.sessionId);
      void (async () => {
        await connection.send('Runtime.enable', {}, session);
        await connection.send('Page.enable', {}, session);
        await connection.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }, { urlPattern: 'file://*' }] }, session);
        await connection.send('Runtime.runIfWaitingForDebugger', {}, session);
      })().catch(stop);
    });
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, page.sessionId);
    connection.on('Runtime.executionContextCreated', (event, session) => {
      if (!session) return;
      const ctx = event.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
      if (ctx.auxData?.isDefault && ctx.auxData.frameId) contexts.set(`${session}:${ctx.id}`, { id: ctx.id, frame: ctx.auxData.frameId, session });
    });
    connection.on('Runtime.executionContextDestroyed', (event, session) => contexts.delete(`${session}:${event.executionContextId}`));
    connection.on('Runtime.executionContextsCleared', (_event, session) => { for (const [key, ctx] of contexts) if (ctx.session === session) contexts.delete(key); });
    const [runtime, css] = await Promise.all([
      readRuntimeSource(),
      readFile(new URL('../src/interactive-design.css', import.meta.url), 'utf8'),
    ]);
    let contextId: number | undefined;
    let evaluationSession = page.sessionId;
    const evaluate = async (expression: string) => {
      signal.throwIfAborted();
      if (!contextId) throw new Error('先调用 preview 加载当前作品');
      const result = await connection.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, evaluationSession);
      if (result.exceptionDetails) throw new Error('页面操作执行失败：' + JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const observe = async (): Promise<PreviewObservationInput> => {
      const state = await evaluate(`(()=>{const text=document.body.innerText||'';const controls=Array.from(document.querySelectorAll('input,select,button,textarea'));const visible=e=>{const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&e.getClientRects().length>0};return {text:text.slice(0,8000),width:innerWidth,height:innerHeight,controlCount:controls.length,textTruncated:text.length>8000,controlsTruncated:controls.length>20,controls:controls.slice(0,20).map(e=>({id:e.id,tag:e.tagName,value:'value'in e?String(e.value):'',text:(e.textContent||'').slice(0,100),visible:visible(e)}))}})()`) as PreviewState;
      const recordedErrors = await page.evaluate<unknown[]>('window.__previewErrors');
      const allErrors = [...recordedErrors, ...navigationErrors];
      const shot = await connection.send<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page.sessionId);
      const truncation = [
        ...(state.textTruncated ? ['可见文字超过 8000 字符'] : []),
        ...(state.controlsTruncated ? [`控件仅记录前 20 个，共 ${state.controlCount} 个`] : []),
        ...(allErrors.length > 20 ? ['异常仅记录前 20 条'] : []),
      ];
      return { state, errors: allErrors.slice(0, 20), image: shot.data, truncated: truncation.length > 0, truncation };
    };
    return {
      observe,
      async load(html: string) {
        const size = DEFAULT_VIEWPORT;
        contextId = undefined;
        contexts.clear();
        navigationErrors.length = 0;
        await connection.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, page.sessionId);
        const doc = buildDocument(html, runtime, css);
        await page.evaluate(`document.body.replaceChildren();document.body.style.cssText='margin:0';window.__previewErrors=[];window.onmessage=e=>{if(e.source===document.querySelector('iframe')?.contentWindow&&e.data?.type==='resprout:display-error')window.__previewErrors.push(e.data)};var f=document.createElement('iframe');f.sandbox='allow-scripts';f.style.cssText='width:${size.width}px;height:${size.height}px;border:0;display:block';f.srcdoc=${JSON.stringify(doc)};document.body.append(f);`);
        for (let i = 0; i < 40; i++) {
          signal.throwIfAborted();
          const tree = await connection.send<{ frameTree: { childFrames?: { frame: { id: string } }[] } }>('Page.getFrameTree', {}, page.sessionId);
          const child = tree.frameTree.childFrames?.[0]?.frame.id;
          const ctx = [...contexts.values()].find(ctx => ctx.frame === child)
            ?? [...contexts.values()].find(ctx => ctx.session !== page.sessionId);
          contextId = ctx?.id;
          evaluationSession = ctx?.session ?? page.sessionId;
          if (contextId) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await new Promise(resolve => setTimeout(resolve, 700));
        return observe();
      },
      async act(action: string, selector: string, value: string) {
        if (!['click', 'set', 'wait'].includes(action)) throw new Error('不支持的操作');
        let actionResult;
        if (action === 'wait') {
          const actualWaitMs = waitDuration(value);
          await new Promise(resolve => setTimeout(resolve, actualWaitMs));
          actionResult = { requestedValue: value, actualValue: '', inputStatus: 'not_applicable' as const, actualWaitMs };
        } else {
          actionResult = await evaluate(`(()=>{const es=document.querySelectorAll(${JSON.stringify(selector)});if(es.length!==1)throw Error('目标必须唯一');const e=es[0];if(${JSON.stringify(action)}==='click'){e.click();return {requestedValue:${JSON.stringify(value)},actualValue:'value'in e?String(e.value):'',inputStatus:'not_applicable',actualWaitMs:null}}if(!['INPUT','SELECT','TEXTAREA'].includes(e.tagName))throw Error('不是输入控件');const requested=${JSON.stringify(value)};e.value=requested;const assigned=String(e.value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {requestedValue:requested,actualValue:String(e.value),inputStatus:assigned===requested?'unchanged':(requested!==''&&assigned===''?'rejected':'normalized'),actualWaitMs:null}})()`) as { requestedValue: string; actualValue: string; inputStatus: 'unchanged' | 'normalized' | 'rejected' | 'not_applicable'; actualWaitMs: null };
          await new Promise(resolve => setTimeout(resolve, 700));
        }
        return { ...await observe(), actionResult };
      },
      close: async () => { signal.removeEventListener('abort', stop); connection.close(); await browser.close(); },
    };
  } catch (error) {
    signal.removeEventListener('abort', stop);
    cdp?.close();
    await browser.close();
    throw error;
  }
}
