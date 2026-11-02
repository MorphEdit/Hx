// hx runs from node_modules (#208, PRD #183 §A0, §A1, §A3): the Node check first, the type-stripping hook, hx --version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hxVersion } from '../src/cli.ts';
import { NEEDED, nodeCheck, nodeFix, nodeOk } from '../bin/node-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, ...extra };
  if (!extra.HX_NODE_VERSION) delete e.HX_NODE_VERSION;
  return e;
};

test('hx --version prints the package.json version and exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), '--version'], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), version);
});

test('hxVersion reads the package.json next to src/', () => {
  assert.equal(hxVersion(), version);
});

test('hx help lists --version', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--version/);
});

test('hx runs from node_modules/hx: --version from a copied package', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'hx-nm-'));
  try {
    const pkg = path.join(tmp, 'node_modules', 'hx');
    for (const p of ['bin', 'src', 'prompts', 'scripts', 'package.json']) cpSync(path.join(root, p), path.join(pkg, p), { recursive: true });
    const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'hx.mjs'), '--version'], { cwd: tmp, encoding: 'utf8', env: env() });
    assert.doesNotMatch(r.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), version);
    assert.equal(r.stderr, '');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('HX_NODE_VERSION=22.0.0: hx help exits 1 with the installed and needed versions and the fix', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'hx.mjs'), 'help'], { encoding: 'utf8', env: env({ HX_NODE_VERSION: '22.0.0' }) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /22\.0\.0/);
  assert.match(r.stderr, /23\.6/);
  assert.ok(r.stderr.includes(nodeFix(process.platform)), r.stderr);
  assert.equal(r.stdout, '');
});

test('nodeOk: 23.5.x is too old, 23.6.0 and 24.x are fine', () => {
  assert.equal(NEEDED, '23.6');
  for (const v of ['22.0.0', '23.0.0', '23.5.0', '23.5.9', 'v23.5.1']) assert.equal(nodeOk(v), false, v);
  for (const v of ['23.6.0', 'v23.6.0', '23.10.0', '24.0.0', '24.12.0']) assert.equal(nodeOk(v), true, v);
});

test('nodeCheck: per-OS fix text, null when new enough', () => {
  assert.equal(nodeCheck('23.6.0', 'win32'), null);
  assert.equal(nodeCheck('24.1.0', 'linux'), null);
  const win = nodeCheck('23.5.2', 'win32')!;
  assert.match(win, /23\.5\.2/); assert.match(win, />= 23\.6/); assert.match(win, /winget install OpenJS\.NodeJS/);
  assert.match(nodeCheck('22.0.0', 'darwin')!, /brew install node/);
  assert.match(nodeCheck('22.0.0', 'linux')!, /https:\/\/nodejs\.org/);
  assert.doesNotMatch(nodeCheck('22.0.0', 'linux')!, /winget|brew/);
});

test('bin/hx.mjs has no static import of a .ts file', () => {
  const src = readFileSync(path.join(root, 'bin', 'hx.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s[^(]*?from\s*['"][^'"]+\.ts['"]/m);
  assert.doesNotMatch(src, /^\s*import\s*['"][^'"]+\.ts['"]/m);
  assert.match(src, /await import\(['"]\.\.\/src\/cli\.ts['"]\)/);
  for (const f of ['node-check.mjs', 'strip-hook.mjs']) assert.doesNotMatch(readFileSync(path.join(root, 'bin', f), 'utf8'), /\.ts['"]/);
});
