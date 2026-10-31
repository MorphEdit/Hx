// A stand-in for bin/hx.mjs under `hx fleet run`: records its argv, cwd and fleet env to <cwd>/entry.json,
// prints a line and a partial line, and exits with the code in <cwd>/exit-code (default 0).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
writeFileSync('entry.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  HX_FLEET_DIR: process.env.HX_FLEET_DIR ?? null, HX_FLEET_WORKERS: process.env.HX_FLEET_WORKERS ?? null, ipc: !!process.send }));
process.stdout.write('hello\r\nworld');
process.stderr.write('oops\n');
process.exitCode = existsSync('exit-code') ? Number(readFileSync('exit-code', 'utf8')) : 0;
