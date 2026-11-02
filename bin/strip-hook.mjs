// Type stripping for hx's own .ts files. Node refuses to strip types under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a synchronous load hook strips them itself.
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

// stripTypeScriptTypes warns that it is experimental; hx's stderr is read by people and tests, so drop that one warning.
function quietStrip(text) {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    if (!String(w?.message ?? w).includes('stripTypeScriptTypes')) emit.call(process, w, ...rest);
  };
  try { return stripTypeScriptTypes(text); } finally { process.emitWarning = emit; }
}

// `pkgUrl`: hx's package directory as a file URL ending in '/'.
export function registerStripHook(pkgUrl = new URL('../', import.meta.url).href) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(pkgUrl) && /\.ts$/.test(url.split(/[?#]/)[0])) {
        const text = readFileSync(fileURLToPath(url), 'utf8');
        return { format: 'module', source: quietStrip(text), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
