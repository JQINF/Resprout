import { readFile } from 'node:fs/promises';
import { transformWithOxc } from 'vite';
import type { Plugin } from 'vite';

const RUNTIME_RAW_SUFFIX = '/src/interactive-runtime-script.ts?raw';

export function interactiveRuntimeScriptPlugin(): Plugin {
  return {
    name: 'resprout-interactive-runtime',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith(RUNTIME_RAW_SUFFIX)) return null;
      const filename = id.slice(0, -'?raw'.length);
      const source = await readFile(filename, 'utf8');
      const { code } = await transformWithOxc(source, filename, { lang: 'ts' });
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
