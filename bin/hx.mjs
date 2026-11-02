#!/usr/bin/env node
// hx ships with no build step and no deps: its .ts files are type-stripped at load time. Nothing here
// imports a .ts file statically, so the Node check runs before any .ts is loaded.
import { nodeCheck } from './node-check.mjs';

const problem = nodeCheck(process.env.HX_NODE_VERSION || process.versions.node, process.platform);
if (problem) {
  console.error(problem);
  process.exit(1);
}

// (hx install goes here: it runs before the hook is registered.)

const { registerStripHook } = await import('./strip-hook.mjs');
registerStripHook();
const { main } = await import('../src/cli.ts');

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`hx: ${err?.message ?? err}`);
    process.exit(1);
  },
);
