import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
await mkdir(new URL('../dist/node/src/', import.meta.url), { recursive: true });
for (const name of ['interactive-design.css']) {
  await copyFile(new URL(`../src/${name}`, import.meta.url), new URL(`../dist/node/src/${name}`, import.meta.url));
}
const runtimeUrl = new URL('../dist/node/src/interactive-runtime-script.js', import.meta.url);
new Script(await readFile(runtimeUrl, 'utf8'), { filename: runtimeUrl.pathname });
