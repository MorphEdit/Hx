#!/usr/bin/env node
// Fake installed `hx` for the installer tests: records each call in FAKE_HX_LOG. `--version` prints FAKE_HX_VERSION
// (default 0.1.0); it exits 1 when FAKE_HX_BROKEN is set, or with FAKE_HX_FRESH until the fake npm has run (no
// FAKE_NPM_LOG yet: nothing installed). `doctor` prints a line and exits 1 (the installer ignores its code).
import { appendFileSync, existsSync } from 'node:fs';

const a = process.argv.slice(2);
if (process.env.FAKE_HX_LOG) appendFileSync(process.env.FAKE_HX_LOG, a.join(' ') + '\n');
if (a[0] === '--version') {
  if (process.env.FAKE_HX_BROKEN || (process.env.FAKE_HX_FRESH && !existsSync(process.env.FAKE_NPM_LOG ?? ''))) {
    process.stderr.write('Error: Cannot find module hx.mjs\n');
    process.exit(1);
  }
  console.log(process.env.FAKE_HX_VERSION || '0.1.0');
} else if (a[0] === 'doctor') {
  console.log('doctor: gh not logged in');
  process.exit(1);
}
