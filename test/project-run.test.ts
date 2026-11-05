// The project benchmark runner's pure parts (bench/project-lib.mjs): the caps, escaped defects, the repo
// setup step and the result fields. No gh, no claude, no usage spent.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: a plain .mjs bench module
import { auditFails, capCheck, escapedDefects, gateReds, parseJsonl, sessionsByRole, setupRepo, usageTotals } from '../bench/project-lib.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'bench', 'project');
const H = 3_600_000;

const walk = (dir: string, rel = ''): string[] => readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? walk(dir, path.join(rel, d.name)) : [path.join(rel, d.name).split(path.sep).join('/')]));

test('capCheck: continue under both caps, stop at and past the hour cap and the dollar cap', () => {
  const c = (elapsedMs: number, costUsd: number) => capCheck({ elapsedMs, costUsd, maxHours: 4, maxUsd: 60 });
  assert.equal(c(0, 0), 'continue');
  assert.equal(c(4 * H - 1, 59.99), 'continue');
  assert.equal(c(4 * H, 0), 'stop');
  assert.equal(c(5 * H, 10), 'stop');
  assert.equal(c(H, 60), 'stop');
  assert.equal(c(H, 75.5), 'stop');
  assert.equal(capCheck({ elapsedMs: 0.5 * H, costUsd: 1, maxHours: 0.5, maxUsd: 60 }), 'stop');
});

test('escapedDefects: failed for done, null for capped and early, 0 for a clean done run', () => {
  assert.equal(escapedDefects(7, 'done'), 7);
  assert.equal(escapedDefects(0, 'done'), 0);
  assert.equal(escapedDefects(7, 'capped'), null);
  assert.equal(escapedDefects(7, 'early'), null);
  assert.equal(escapedDefects(0, 'early'), null);
});

test('setupRepo: one commit whose tree is the template; nothing from hidden/ or reference/', E2E, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hxp-setup-'));
  try {
    setupRepo(dir);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git('branch', '--show-current').trim(), 'main');
    const template = walk(path.join(project, 'template')).sort();
    const tree = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepEqual(tree, template);
    for (const f of tree) assert.equal(git('show', `HEAD:${f}`), readFileSync(path.join(project, 'template', f), 'utf8'), f);
    const working = walk(dir).filter((f) => !f.startsWith('.git/')).sort();
    assert.deepEqual(working, template);
    // no hidden or reference file by name or by content, in the tree or the working dir
    const contents = new Set(working.map((f) => readFileSync(path.join(dir, f), 'utf8')));
    for (const sub of ['hidden', 'reference']) {
      for (const f of walk(path.join(project, sub))) {
        const text = readFileSync(path.join(project, sub, f), 'utf8');
        // the reference's package.json is the template's own: a file the template ships is allowed
        if (template.includes(f) && readFileSync(path.join(project, 'template', f), 'utf8') === text) continue;
        const base = path.posix.basename(f);
        assert.ok(!working.some((w) => path.posix.basename(w) === base), `${sub}/${f} by name`);
        assert.ok(!contents.has(text), `${sub}/${f} by content`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('result helpers: sessions by role, token and cost sums, audit FAILs, gate reds', () => {
  const u = (role: string, sessionId: string, input: number, output: number, costUsd: number) =>
    ({ role, sessionId, usage: { input, cacheWrite: 1, cacheRead: 2, output }, costUsd });
  const records = [u('impl', 'a', 10, 5, 0.5), u('impl', 'a', 20, 5, 0.25), u('impl', 'b', 1, 1, 1),
    u('review', 'c', 3, 3, 2), { role: 'audit', sessionId: 'd' }];
  assert.deepEqual(sessionsByRole(records), { impl: 2, review: 1, audit: 1 });
  assert.deepEqual(sessionsByRole([]), {});
  const t = usageTotals(records);
  assert.deepEqual(t.tokens, { input: 34, cacheWrite: 4, cacheRead: 8, output: 14, total: 60 });
  assert.equal(t.costUsd, 3.75);
  assert.deepEqual(usageTotals([]), { tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }, costUsd: 0 });

  const runLog = [
    '2026-11-01T10:00:00.000Z [#3] audit FAIL ✗ missing test',
    '2026-11-01T10:05:00.000Z [#3] audit PASS ✓',
    '2026-11-01T10:06:00.000Z [#4] audit FAIL ✗ wrong rounding',
    'audit FAIL ✗ no timestamp: not counted',
    '2026-11-01T10:07:00.000Z [#4] note: audit FAIL ✗ not at the start',
  ].join('\r\n');
  assert.equal(auditFails(runLog), 2);
  assert.equal(auditFails(''), 0);

  const gate = [{ ok: true }, { ok: false, sha: 'a' }, { ok: false, sha: 'b' }, { sha: 'c' }]
    .map((x) => JSON.stringify(x)).join('\n') + '\n{"ok": false, torn\n\n';
  assert.equal(gateReds(gate), 2);
  assert.equal(gateReds(''), 0);

  assert.deepEqual(parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test('bench/project.mjs parses, and no prompt names the hidden suite', () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'bench', 'project.mjs')]);
  const src = readFileSync(path.join(root, 'bench', 'project.mjs'), 'utf8');
  assert.ok(!/project[\\/]hidden|hidden (tests?|suite)/i.test(src.split('// 4.')[0].replace(/^\/\/.*$/gm, '')));
});
