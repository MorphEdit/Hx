// The critic and security evals are only loaded here, never run (they spend real usage). Their fake `gh`
// is checked for real: it must keep every issue, label and comment on its local board and refuse the rest.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bench = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench');
const fakeGh = path.join(bench, 'eval-gh.mjs');
const restore = (saved: NodeJS.ProcessEnv) => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
};
const json = (f: string) => JSON.parse(readFileSync(path.join(bench, f), 'utf8'));

test('both eval scripts and the fake gh pass node --check', () => {
  for (const f of ['critic-eval.mjs', 'security-eval.mjs', 'eval-gh.mjs']) {
    const r = spawnSync(process.execPath, ['--check', path.join(bench, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('the eval scripts never call the real gh: every gh goes through bench/eval-gh.mjs', () => {
  for (const f of ['critic-eval.mjs', 'security-eval.mjs']) {
    const src = readFileSync(path.join(bench, f), 'utf8');
    assert.match(src, /useFakeGh\(/, `${f} installs the fake gh`);
    assert.doesNotMatch(src, /['"]gh['"]/, `${f} spawns gh itself`);
    assert.doesNotMatch(src, /repo['"]?,\s*['"]create|issue['"]?,\s*['"]create/, `${f} creates GitHub repos or issues`);
    assert.match(src.split('\n').slice(0, 25).join('\n'), /node bench\/\w+-eval\.mjs/, `${f} has a usage comment at the top`);
  }
});

test('critic fixtures: an ambiguity, a contradiction, a missing criterion, and one clean PRD', () => {
  const cases = json('critic-eval/cases.json');
  for (const [name, c] of Object.entries<any>(cases)) {
    assert.ok(existsSync(path.join(bench, 'critic-eval', `${name}.md`)), `${name}.md`);
    assert.ok(c.title);
    if (c.defect) assert.doesNotThrow(() => new RegExp(c.match, 'i'), name);
  }
  const defects = Object.values<any>(cases).map((c) => c.defect?.split(':')[0] ?? null);
  for (const kind of ['ambiguity', 'contradiction', 'missing acceptance criterion', null]) assert.ok(defects.includes(kind), String(kind));
});

test('security fixtures: shell injection, rmSync on a computed path, token in a log, and one clean case', () => {
  const cases = json('security-eval/cases.json');
  assert.ok(existsSync(path.join(bench, 'security-eval', 'base', 'package.json')));
  for (const [name, c] of Object.entries<any>(cases)) {
    assert.ok(statSync(path.join(bench, 'security-eval', name)).isDirectory(), name);
    assert.ok(c.prd.title && c.prd.body && c.child, name);
    if (c.vuln) assert.doesNotThrow(() => new RegExp(c.match, 'i'), name);
  }
  const src = (name: string) => readdirSync(path.join(bench, 'security-eval', name, 'src'))
    .map((f) => readFileSync(path.join(bench, 'security-eval', name, 'src', f), 'utf8')).join('\n');
  assert.match(src('shell'), /execSync\(`[^`]*\$\{it\.title\}/);
  assert.match(src('rmsync'), /rmSync\(scratchDir/);
  assert.match(src('token'), /appendFileSync\(LOG,[^\n]*headers/);
  assert.doesNotMatch(src('clean'), /execSync|\bexec\(/);
  assert.equal(Object.values<any>(cases).filter((c) => !c.vuln).length, 1);
});

test('the eval fake gh keeps everything on its local board and refuses anything else', E2E, async () => {
  const { useFakeGh, installFakeGh, board } = await import(pathToFileURL(fakeGh).href);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hx-eg-'));
  const saved = { ...process.env };
  process.env.GH_TOKEN = 'secret-token';
  const env = installFakeGh(dir, [
    { number: 1, title: 'PRD', body: 'the body', state: 'OPEN', labels: ['prd'], comments: ['earlier'] },
    { number: 2, title: 'child', body: 'x', state: 'CLOSED', labels: [], comments: [] },
  ]);
  restore(saved);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!;
  assert.equal(env[pathKey].split(path.delimiter)[0], path.join(dir, 'bin'));
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GH_CONFIG_DIR, path.join(dir, 'gh-config'));
  assert.ok(existsSync(path.join(dir, 'bin', 'gh')) && existsSync(path.join(dir, 'bin', 'gh.cmd')));
  const gh = (args: string[], input?: string) => spawnSync(process.execPath, [fakeGh, ...args], { env, input, encoding: 'utf8' });

  const view = gh(['issue', 'view', '1', '-R', 'o/r', '--comments']);
  assert.equal(view.status, 0);
  assert.match(view.stdout, /title:\tPRD[\s\S]*the body[\s\S]*earlier/);
  assert.equal(gh(['issue', 'view', '1', '--json', 'labels', '-q', '.labels[].name']).stdout.trim(), 'prd');
  assert.match(gh(['issue', 'list', '--state', 'all', '--json', 'number,state']).stdout, /"number":2,"state":"CLOSED"/);

  const created = gh(['issue', 'create', '-R', 'o/r', '--label', 'ready-for-agent', '--label', 'security', '--title', 'security: x', '--body-file', '-'], 'exploit\n## Parent\n#1\n');
  assert.equal(created.status, 0);
  assert.match(created.stdout, /issues\/3$/m);
  assert.equal(gh(['issue', 'edit', '1', '--add-label', 'security-reviewed']).status, 0);
  assert.equal(gh(['issue', 'comment', '1', '--body', '<!-- hx-security -->\nok']).status, 0);
  const b = board.load(dir);
  assert.deepEqual(b.issues.find((i: any) => i.number === 3), { number: 3, title: 'security: x', body: 'exploit\n## Parent\n#1\n', state: 'OPEN', labels: ['ready-for-agent', 'security'], comments: [], filed: true });
  assert.deepEqual(b.issues[0].labels, ['prd', 'security-reviewed']);
  assert.equal(b.issues[0].comments[1], '<!-- hx-security -->\nok');

  for (const args of [['repo', 'create', 'o/x', '--private'], ['api', 'user'], ['pr', 'merge', '1'], ['issue', 'close', '1']]) {
    const r = gh(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /not available in this eval/);
  }
  assert.equal(readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').length, 10);

  // useFakeGh puts it in this process's env, from the env at load: a second board replaces the first
  useFakeGh(path.join(dir, 'a'), []);
  useFakeGh(path.join(dir, 'b'), []);
  const p = process.env[pathKey]!.split(path.delimiter);
  assert.equal(p[0], path.join(dir, 'b', 'bin'));
  assert.ok(!p.includes(path.join(dir, 'a', 'bin')));
  assert.equal(process.env.HX_EVAL_GH, path.join(dir, 'b'));
  restore(saved);
});
