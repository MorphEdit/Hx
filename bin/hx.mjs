#!/usr/bin/env node
// hx ships with no build step and no deps: its .ts files are type-stripped at load time. Nothing here
// imports a .ts file statically, so the Node check runs before any .ts is loaded.
import { nodeCheck } from './node-check.mjs';

const problem = nodeCheck(process.env.HX_NODE_VERSION || process.versions.node, process.platform);
if (problem) {
  console.error(problem);
  process.exit(1);
}

// hx install / hx update: before the hook is registered, so no .ts is loaded.
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'install' || cmd === 'update') {
  const { install } = await import('./install.mjs');
  process.exit(await install(rest, { update: cmd === 'update' }));
}

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
