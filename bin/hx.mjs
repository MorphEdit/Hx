#!/usr/bin/env node
// Node >= 23.6 runs .ts directly (type stripping), so hx ships with no build step and no deps.
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`hx: ${err?.message ?? err}`);
    process.exit(1);
  },
);
