import { normalizeInteractiveMath } from './interactive-math.ts';
import { serializeInteractiveProtocol, INTERACTIVE_TEST_CONFIG_ELEMENT_ID } from './interactive-protocol.ts';
import type { InteractiveRuntimeConfig } from './interactive-protocol.ts';

/** Shared by the actual card and the agent's isolated preview. */
export function buildDocument(content: string, runtime: string, css: string, config?: InteractiveRuntimeConfig | null): string {
  const html = normalizeInteractiveMath(String(content ?? ''));
  const configTag = config ? `<script id="${INTERACTIVE_TEST_CONFIG_ELEMENT_ID}" type="application/json">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>` : '';
  const metadata = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${configTag}<script id="resprout-runtime">${runtime.replace('__RESPROUT_PROTOCOL__', () => serializeInteractiveProtocol())}</script>`;
  const styles = `<style>${css}</style>`;
  if (/<html[\s>]/i.test(html)) {
    if (/<head(?:\s[^>]*)?>/i.test(html)) {
      const withRuntime = html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${metadata}`);
      return /<\/head>/i.test(withRuntime) ? withRuntime.replace(/<\/head>/i, `${styles}</head>`) : withRuntime;
    }
    return html.replace(/<html[^>]*>/i, match => `${match}<head>${metadata}${styles}</head>`);
  }
  return `<!doctype html><html><head>${metadata}${styles}</head><body>${html}</body></html>`;
}
