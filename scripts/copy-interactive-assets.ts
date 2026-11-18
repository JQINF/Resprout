import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/node/src/', import.meta.url), { recursive: true });
for (const name of ['interactive-runtime-script.js', 'interactive-design.css']) {
  await copyFile(new URL(`../src/${name}`, import.meta.url), new URL(`../dist/node/src/${name}`, import.meta.url));
}
