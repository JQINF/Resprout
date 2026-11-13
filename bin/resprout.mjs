#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = resolve(packageRoot, 'dist');
const sidecarPath = fileURLToPath(new URL('../sidecar/index.mjs', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const defaultHost = '127.0.0.1';
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

function parseArgs(args) {
  const options = {
    port: parsePort(process.env.RESPROUT_PORT ?? 4173, 'RESPROUT_PORT'),
    sidecarPort: parsePort(process.env.SIDECAR_PORT ?? 8787, 'SIDECAR_PORT'),
    open: true,
    help: false,
    version: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--port' || argument === '--sidecar-port') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      if (argument === '--port') options.port = parsePort(value, '--port');
      else options.sidecarPort = parsePort(value, '--sidecar-port');
    } else if (argument.startsWith('--port=')) {
      options.port = parsePort(argument.slice('--port='.length), '--port');
    } else if (argument.startsWith('--sidecar-port=')) {
      options.sidecarPort = parsePort(argument.slice('--sidecar-port='.length), '--sidecar-port');
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.port === options.sidecarPort) throw new Error('Frontend and sidecar ports must be different.');
  return options;
}

function printHelp() {
  console.log(`Resprout — a canvas for divergent learning

Usage:
  resprout [options]

Options:
  --port <port>          Frontend port (default: 4173)
  --sidecar-port <port>  Local model-service port (default: 8787)
  --no-open              Do not open the browser automatically
  -v, --version          Print the package version
  -h, --help             Show this help

Environment:
  RESPROUT_PORT          Default frontend port
  SIDECAR_PORT           Default sidecar port
  RESPROUT_CONFIG_DIR    Provider configuration directory
                         (default: ~/.resprout)`);
}

function sendText(response, status, text) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

async function fileAt(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = resolve(distRoot, relative);
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) return null;
  try {
    const info = await stat(filePath);
    return info.isFile() ? filePath : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!extname(relative)) return fileAt('/index.html');
    return null;
  }
}

async function serveStatic(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }
  const pathname = new URL(request.url, `http://${defaultHost}`).pathname;
  const filePath = await fileAt(pathname);
  if (!filePath) {
    sendText(response, 404, 'Not found');
    return;
  }
  const extension = extname(filePath);
  response.writeHead(200, {
    'content-type': mimeTypes[extension] ?? 'application/octet-stream',
    'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function proxyApi(request, response, sidecarPort) {
  const proxy = http.request({
    hostname: defaultHost,
    port: sidecarPort,
    path: request.url,
    method: request.method,
    headers: { ...request.headers, host: `${defaultHost}:${sidecarPort}` },
  }, upstream => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on('error', () => {
    if (!response.headersSent) sendText(response, 502, 'The Resprout sidecar is unavailable.');
    else response.destroy();
  });
  request.on('aborted', () => proxy.destroy());
  response.on('close', () => {
    if (!response.writableEnded) proxy.destroy();
  });
  request.pipe(proxy);
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, defaultHost, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function checkSidecar(port) {
  return new Promise(resolveCheck => {
    const request = http.get({ hostname: defaultHost, port, path: '/api/providers', timeout: 500 }, response => {
      response.resume();
      resolveCheck(response.statusCode === 200);
    });
    request.on('timeout', () => {
      request.destroy();
      resolveCheck(false);
    });
    request.on('error', () => resolveCheck(false));
  });
}

async function waitForSidecar(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await checkSidecar(port)) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  return false;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`resprout: ${error.message}`);
    console.error('Run "resprout --help" for usage.');
    process.exitCode = 1;
    return;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    console.log(packageJson.version);
    return;
  }
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
    console.error(`resprout requires Node.js 22.19 or newer; current version is ${process.versions.node}.`);
    process.exitCode = 1;
    return;
  }
  try {
    await stat(join(distRoot, 'index.html'));
  } catch {
    console.error('resprout: dist/index.html is missing. Run "npm run build" before starting from source.');
    process.exitCode = 1;
    return;
  }

  const configDir = resolve(process.env.RESPROUT_CONFIG_DIR ?? join(homedir(), '.resprout'));
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/api')) proxyApi(request, response, options.sidecarPort);
    else serveStatic(request, response).catch(error => {
      if (!response.headersSent) sendText(response, 500, 'Unable to serve the application.');
      else response.destroy();
      console.error(`resprout: ${error.message}`);
    });
  });
  let sidecar = null;
  let stopping = false;
  const shutdown = code => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
    if (sidecar && sidecar.exitCode === null && sidecar.signalCode === null) sidecar.kill('SIGTERM');
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  try {
    await listen(server, options.port);
  } catch (error) {
    console.error(`resprout: cannot listen on ${defaultHost}:${options.port} (${error.code ?? error.message}).`);
    console.error('Choose another frontend port with --port.');
    process.exitCode = 1;
    return;
  }

  sidecar = spawn(process.execPath, [sidecarPath], {
    cwd: dirname(sidecarPath),
    env: { ...process.env, SIDECAR_PORT: String(options.sidecarPort), RESPROUT_CONFIG_DIR: configDir },
    stdio: 'inherit',
  });
  sidecar.on('error', error => {
    console.error(`resprout: unable to start the sidecar: ${error.message}`);
    shutdown(1);
  });
  sidecar.on('exit', code => {
    if (!stopping) {
      console.error(`resprout: sidecar stopped unexpectedly${code ? ` with code ${code}` : ''}. Check --sidecar-port ${options.sidecarPort}.`);
      shutdown(code || 1);
    }
  });
  if (!await waitForSidecar(options.sidecarPort)) {
    console.error('resprout: sidecar did not become ready within 10 seconds.');
    shutdown(1);
    return;
  }

  const url = `http://${defaultHost}:${options.port}`;
  console.log(`\nResprout ${packageJson.version} is ready`);
  console.log(`  Local:   ${url}`);
  console.log(`  Config:  ${configDir}`);
  console.log('  Stop:    Ctrl+C\n');
  if (options.open) openBrowser(url);
}

main().catch(error => {
  console.error(`resprout: ${error.message}`);
  process.exitCode = 1;
});
