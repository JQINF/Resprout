import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { interactiveRuntimeScriptPlugin } from './scripts/interactive-runtime-plugin.ts';

export default defineConfig({
  plugins: [interactiveRuntimeScriptPlugin(), react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${process.env.SIDECAR_PORT ?? 8787}`,
    },
  },
});
