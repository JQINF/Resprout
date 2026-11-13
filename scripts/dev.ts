import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [
  spawn(process.execPath, ['--watch', 'sidecar/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env }),
];
let stopping = false;

function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) {
  child.on('error', error => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', code => {
    if (!stopping) stop(code ?? 0);
  });
}
