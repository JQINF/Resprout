/**
 * 极简 CDP 客户端：启动系统 Chromium 内核浏览器（优先 Microsoft Edge），
 * 通过 DevTools 协议打开页面并执行异步断言。不依赖 Playwright/Puppeteer。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSER_CANDIDATES = [
  process.env.RESPROUT_BROWSER,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((value): value is string => Boolean(value));

export interface BrowserHandle {
  executable: string;
  version: string;
  wsUrl: string;
  close: () => Promise<void>;
}

export function findBrowser(): string {
  const executable = BROWSER_CANDIDATES.find(path => existsSync(path));
  if (!executable) {
    throw new Error('未找到 Chromium 内核浏览器。可通过 RESPROUT_BROWSER 指定可执行文件路径。');
  }
  return executable;
}

function waitForDevTools(child: ChildProcess, executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`浏览器启动超时：${executable}\n${stderr.slice(-2000)}`));
    }, 20000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`浏览器提前退出（${code}）：${stderr.slice(-2000)}`));
    });
  });
}

export async function launchBrowser(): Promise<BrowserHandle> {
  const executable = findBrowser();
  const userDataDir = mkdtempSync(join(tmpdir(), 'resprout-browser-'));
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl: string;
  try { wsUrl = await waitForDevTools(child, executable); }
  catch (error) { child.kill('SIGKILL'); rmSync(userDataDir, { recursive: true, force: true }); throw error; }
  const versionOutput = await new Promise<string>(resolve => {
    const probe = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    probe.stdout?.on('data', chunk => { text += chunk.toString(); });
    probe.on('exit', () => resolve(text.trim() || executable));
    probe.on('error', () => resolve(executable));
  });
  let closed = false;
  return {
    executable,
    version: versionOutput,
    wsUrl,
    close: async () => {
      if (closed) return;
      closed = true;
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 300));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不影响测试结果
      }
    },
  };
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CdpConnection {
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private nextId = 1;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (typeof message.method !== 'string') return;
      const handlers = this.listeners.get(message.method);
      if (!handlers) return;
      const params = (message.params ?? {}) as Record<string, unknown>;
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      for (const handler of handlers) handler(params, sessionId);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error(`无法连接 CDP：${url}`)), { once: true });
    });
    return new CdpConnection(socket);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(handler);
    return () => { handlers?.delete(handler); };
  }

  waitForEvent<T = Record<string, unknown>>(method: string, sessionId: string, timeoutMs = 15000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 CDP 事件超时：${method}`));
      }, timeoutMs);
      const off = this.on(method, (params, eventSession) => {
        if (eventSession !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(params as T);
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

export interface BrowserPage {
  sessionId: string;
  navigate: (url: string) => Promise<void>;
  evaluate: <T>(expression: string, awaitPromise?: boolean) => Promise<T>;
  waitForFunction: (expression: string, timeoutMs?: number) => Promise<void>;
}

export async function openPage(cdp: CdpConnection): Promise<BrowserPage> {
  const target = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => {
    const response = await cdp.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, sessionId);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? '浏览器执行异常';
      throw new Error(description);
    }
    return response.result.value as T;
  };

  const navigate = async (url: string): Promise<void> => {
    const loaded = cdp.waitForEvent('Page.loadEventFired', sessionId, 20000);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    const started = Date.now();
    while (Date.now() - started < 10000) {
      const readyState = await evaluate<string>('document.readyState');
      if (readyState === 'complete') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`页面加载未完成：${url}`);
  };

  const waitForFunction = async (expression: string, timeoutMs = 15000): Promise<void> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await evaluate<boolean>(`Boolean(${expression})`);
      if (value) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`等待页面函数超时：${expression}`);
  };

  return { sessionId, navigate, evaluate, waitForFunction };
}
