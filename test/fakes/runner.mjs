// A stand-in for bin/hx.mjs under `hx supervise`: appends its argv and cwd to <cwd>/runs.log, takes the first exit code
// from <cwd>/codes.json (default 0), waits <cwd>/up-ms milliseconds (default 0), then exits with that code.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
appendFileSync('runs.log', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), at: Date.now() }) + '\n');
const codes = existsSync('codes.json') ? JSON.parse(readFileSync('codes.json', 'utf8')) : [];
const code = codes.length ? codes.shift() : 0;
writeFileSync('codes.json', JSON.stringify(codes));
const up = existsSync('up-ms') ? Number(readFileSync('up-ms', 'utf8')) : 0;
setTimeout(() => process.exit(code), up);
