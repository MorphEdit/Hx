// The npx installer and hx update (#212, PRD #183 §A1-§A3b): latest tag, npm install -g, verify, doctor, skill question.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkedCheckout, shimTarget, which } from '../bin/install.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakes = path.join(root, 'test', 'fakes');
const win = process.platform === 'win32';

// A GitHub API on localhost: /repos/MorphEdit/Hx/releases/latest answers `tag` (500 when tag is null).
async function api(tag: string | null): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (tag && req.url === '/repos/MorphEdit/Hx/releases/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: tag }));
    } else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  let closed = false;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => (closed ? Promise.resolve() : (closed = true, new Promise((r) => server.close(() => r())))) };
}

// A temp folder with a fake installed hx first on PATH: <tmp>/bin/hx(.cmd) → <tmp>/pkg/node_modules/hx/bin/hx.mjs,
// or with `linked` <tmp>/checkout/Hx/bin/hx.mjs next to a .git (an npm link of a checkout).
function setup(o: { linked?: boolean } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-inst-'));
  const pkg = o.linked ? path.join(tmp, 'checkout', 'Hx') : path.join(tmp, 'pkg', 'node_modules', 'hx');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  if (o.linked) mkdirSync(path.join(pkg, '.git'));
  const script = path.join(pkg, 'bin', 'hx.mjs');
  copyFileSync(path.join(fakes, 'hx.mjs'), script);
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  // npm's own shapes: a cmd shim on Windows, a symlink to the script elsewhere
  if (win) writeFileSync(path.join(bin, 'hx.cmd'), `@ECHO off\r\nnode  "%dp0%\\${path.relative(bin, script)}" %*\r\n`);
  else { chmodSync(script, 0o755); symlinkSync(script, path.join(bin, 'hx')); }
  return { tmp, bin, npmLog: path.join(tmp, 'npm.log'), hxLog: path.join(tmp, 'hx.log'), done: () => rmSync(tmp, { recursive: true, force: true }) };
}
type Setup = ReturnType<typeof setup>;

// bin/hx.mjs with stdin a pipe (not a TTY), async so the fake API in this process can answer.
function hx(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const base: Record<string, string | undefined> = { ...process.env };
    if (env.PATH) for (const k of Object.keys(base)) if (k.toUpperCase() === 'PATH') delete base[k]; // Windows: Path
    const child = spawn(process.execPath, [path.join(root, 'bin', 'hx.mjs'), ...args], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.end();
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []);
const envFor = (s: Setup, apiUrl: string, extra: Record<string, string> = {}) => ({
  PATH: s.bin + path.delimiter + process.env.PATH, HX_NPM_BIN: path.join(fakes, 'npm.mjs'), HX_GITHUB_API: apiUrl,
  FAKE_NPM_LOG: s.npmLog, FAKE_HX_LOG: s.hxLog, ...extra,
});

test('install: npm install -g the latest tag from the API, verify, doctor, no skill without a TTY, exit 0', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { FAKE_HX_VERSION: '0.4.2' }));
    assert.equal(r.code, 0, r.err + r.out);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.4.2']);
    assert.deepEqual(a.hits, ['/repos/MorphEdit/Hx/releases/latest']);
    assert.match(r.out, /hx v0\.4\.2 → v0\.4\.2/);
    assert.match(r.out, /doctor: gh not logged in/); // doctor's exit 1 does not change the installer's
    assert.match(r.out, /Install the \/hx skill for Claude Code\? \[y\/N\]/);
    assert.deepEqual(lines(s.hxLog), ['--version', '--version', 'doctor']); // before, verify, doctor: no install-skill
  } finally { await a.close(); s.done(); }
});

test('install: an hx that did not run before is a fresh install', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { FAKE_HX_FRESH: '1', FAKE_HX_VERSION: '0.4.2' }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /hx v0\.4\.2 \(fresh install\)/);
    assert.doesNotMatch(r.out, /→/);
  } finally { await a.close(); s.done(); }
});

test('install --version v0.1.0 pins the ref and does not ask the API', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install', '--version', 'v0.1.0'], envFor(s, a.url));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.1.0']);
    assert.deepEqual(a.hits, []);
  } finally { await a.close(); s.done(); }
});

test('install: a --version that is not a release tag is refused before npm', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install', '--version', 'main&calc'], envFor(s, a.url));
    assert.equal(r.code, 2);
    assert.deepEqual(lines(s.npmLog), []);
  } finally { await a.close(); s.done(); }
});

test('install: a failed tag lookup (500, unreachable) falls back to the default branch and says so', E2E, async () => {
  const s = setup(); const a = await api(null);
  try {
    let r = await hx(['install'], envFor(s, a.url));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /could not look up the latest release tag; installing from the default branch/);
    await a.close();
    r = await hx(['install'], envFor(s, a.url)); // the server is gone: unreachable
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /installing from the default branch/);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx', 'install -g github:MorphEdit/Hx']);
  } finally { await a.close(); s.done(); }
});

test('install: an hx that fails --version after the install → exit 1, the PATH hint, no doctor, no skill', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { FAKE_HX_BROKEN: '1' }));
    assert.equal(r.code, 1);
    assert.match(r.err, /hx was installed but does not run from a new terminal/);
    assert.match(r.err, /Cannot find module hx\.mjs/); // the failed run's output
    assert.match(r.err, /npm prefix -g/);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.4.2']);
    assert.ok(!lines(s.hxLog).includes('doctor'));
    assert.ok(!lines(s.hxLog).includes('install-skill'));
    assert.doesNotMatch(r.out, /Install the \/hx skill/);
  } finally { await a.close(); s.done(); }
});

test('install: no hx on PATH after the install is the same failure', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { PATH: path.join(s.tmp, 'empty') }));
    assert.equal(r.code, 1);
    assert.match(r.err, /hx was installed but does not run from a new terminal/);
    assert.match(r.err, /npm prefix -g/);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.4.2']);
  } finally { await a.close(); s.done(); }
});

test('install with HX_NODE_VERSION=22.0.0 exits 1 with the fix text and never calls npm', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { HX_NODE_VERSION: '22.0.0' }));
    assert.equal(r.code, 1);
    assert.match(r.err, /22\.0\.0/);
    assert.match(r.err, /23\.6/);
    assert.match(r.err, win ? /winget install OpenJS\.NodeJS/ : /brew install node|nodejs\.org/);
    assert.deepEqual(lines(s.npmLog), []);
    assert.deepEqual(a.hits, []);
  } finally { await a.close(); s.done(); }
});

test('install: a failing npm → exit 1 with npm\'s error and the npm config set prefix hint, called once (no retry)', E2E, async () => {
  const s = setup(); const a = await api('v0.4.2');
  try {
    const r = await hx(['install'], envFor(s, a.url, { FAKE_NPM_EXIT: '243' }));
    assert.equal(r.code, 1);
    assert.match(r.err, /EACCES/);
    assert.match(r.err, /npm config set prefix/);
    assert.match(r.err, /version manager/);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.4.2']);
    assert.deepEqual(lines(s.hxLog), ['--version']); // only the version before: no verify, no doctor
  } finally { await a.close(); s.done(); }
});

test('install: a linked checkout is not overwritten without --force; --force installs', E2E, async () => {
  const s = setup({ linked: true }); const a = await api('v0.4.2');
  try {
    let r = await hx(['install'], envFor(s, a.url));
    assert.equal(r.code, 1);
    assert.match(r.out, /npm link of the checkout .*Hx/);
    assert.match(r.out, /--force/);
    assert.deepEqual(lines(s.npmLog), []);
    r = await hx(['install', '--force'], envFor(s, a.url));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.4.2']);
  } finally { await a.close(); s.done(); }
});

test('hx update calls npm with the latest tag and takes no --version', E2E, async () => {
  const s = setup(); const a = await api('v0.5.0');
  try {
    const r = await hx(['update'], envFor(s, a.url));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(lines(s.npmLog), ['install -g github:MorphEdit/Hx#v0.5.0']);
    assert.match(r.out, /doctor: gh not logged in/);
    const bad = await hx(['update', '--version', 'v0.1.0'], envFor(s, a.url));
    assert.equal(bad.code, 2);
    assert.equal(lines(s.npmLog).length, 1);
  } finally { await a.close(); s.done(); }
});

test('hx help lists update', E2E, async () => {
  const r = await hx(['help'], {});
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\s+update \[--force\]/m);
});

test('which, shimTarget and linkedCheckout find the hx on PATH and tell a linked checkout apart', E2E, () => {
  const s = setup(); const l = setup({ linked: true });
  try {
    const p = which('hx', { PATH: s.bin });
    assert.ok(p && path.dirname(p) === s.bin, String(p));
    assert.equal(which('hx', { PATH: path.join(s.tmp, 'nope') }), null);
    if (win) assert.match(shimTarget(p!)!, /node_modules[\\/]hx[\\/]bin[\\/]hx\.mjs$/);
    assert.equal(linkedCheckout(p), null);
    assert.equal(linkedCheckout(null), null);
    assert.ok(linkedCheckout(which('hx', { PATH: l.bin }))?.endsWith(path.join('checkout', 'Hx')));
  } finally { s.done(); l.done(); }
});
