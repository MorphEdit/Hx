// Directory cases in the project fuzz (bench/project-fuzz.mjs, PRD #446, #448): a case with `files` writes them into
// its directory, and the data directory the manifest names is read back and compared. A toy fixture in a temp
// directory: a generator of directory cases and a reference CLI that reads the CSV files of TOY_DIR and appends to one.
import { E2E } from './isolate.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore: a plain .mjs bench script
import { differs, fuzz, genHash, isDirCase, readTree, runSide } from '../bench/project-fuzz.mjs';

// far above a node start on a loaded machine (#285), where the point is not a timeout
const LIMIT = 120_000;
const manifest = { bin: 'toy', checkoutEnv: 'TOY_CHECKOUT', coverageClearEnv: [], fuzzFile: 'db', fuzzFileEnv: 'TOY_DIR', fuzzNowEnv: 'TOY_NOW' };
const names = { file: 'db', fileEnv: 'TOY_DIR', nowEnv: 'TOY_NOW', bin: 'toy' };

const dirs: string[] = [];
/** A fresh directory whose path holds a space. */
function spaced(): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'hx fuzzdir ')), 'my checkout');
  mkdirSync(dir);
  dirs.push(path.dirname(dir));
  return dir;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// five shapes in turn: no files; a table to append to beside one a variant deletes; a table in a subdirectory; a script
// outside the data directory; an empty case directory, where the data directory is created
const GENERATOR = `export const DEFAULT_SEED = 7;
export const DEFAULT_COUNT = 10;
const b = (s) => Buffer.from(s);
export function generate({ seed = DEFAULT_SEED, count = DEFAULT_COUNT } = {}) {
  return Array.from({ length: count }, (_, id) => {
    const now = '2024-01-0' + (1 + ((seed + id) % 9));
    const v = String(seed * 100 + id);
    switch (id % 5) {
      case 0: return { id, feature: 'empty', args: ['count'], files: null, now };
      case 1: return { id, feature: 'append', args: ['append', 'a', v], files: { 'db/a.csv': b('n\\n1\\n'), 'db/old.csv': b('y\\n') }, now };
      case 2: return { id, feature: 'nested', args: ['count'], files: { 'db/nested/deep.csv': b('z\\n2\\n3\\n') }, now };
      case 3: return { id, feature: 'script', args: ['run', 'script.sql'], files: { 'db/a.csv': b('n\\n'), 'script.sql': b('append a ' + v + '\\n') }, now };
      default: return { id, feature: 'new', args: ['append', 'b', v], files: {}, now };
    }
  });
}
`;

const CLI = `import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.TOY_DIR;
const walk = (d, pre = '') => fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), pre + e.name + '/') : e.name.endsWith('.csv') ? [pre + e.name] : []));
const append = (t, v) => { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, t + '.csv'), v + '\\n'); };
const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'count') {
  console.log(process.env.TOY_NOW);
  if (!fs.existsSync(dir)) console.log('no data');
  else for (const f of walk(dir)) console.log(f, fs.readFileSync(path.join(dir, f), 'utf8').split('\\n').filter(Boolean).length);
} else if (cmd === 'append') append(a[0], a[1]);
else if (cmd === 'run') for (const line of fs.readFileSync(a[0], 'utf8').split('\\n').filter(Boolean)) append(line.split(' ')[1], line.split(' ')[2]);
else { console.error('toy: unknown command'); process.exit(2); }
// HOOK
`;

/** A checkout holding the toy CLI, with `from` replaced by `to`. */
function toy(from = '', to = ''): string {
  const dir = spaced();
  assert.ok(CLI.includes(from));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'toy', bin: { toy: 'toy.mjs' } }));
  writeFileSync(path.join(dir, 'toy.mjs'), from ? CLI.replace(from, to) : CLI);
  return dir;
}
const generatorFile = path.join(spaced(), 'gen.mjs');
writeFileSync(generatorFile, GENERATOR);
const reference = toy();
const fixture = { name: 'toy', generator: generatorFile, reference, manifest };
const cases = (await import(pathToFileURL(generatorFile).href)).generate();

type Bytes = { base64: string; text: string } | null;
const raw = (b: Bytes) => (b === null ? null : Buffer.from(b.base64, 'base64'));
const rawTree = (t: Record<string, Bytes> | null) => (t === null ? null
  : Object.fromEntries(Object.entries(t).map(([k, v]) => { assert.equal(raw(v)!.toString('utf8'), v!.text); return [k, raw(v)]; })));
const ids = (r: any, cls: string) => r.examples[cls].map((e: any) => e.case.id);

test('the toy reference fuzzed against itself: 0 divergences, nothing excluded', E2E, async () => {
  assert.ok(cases.every(isDirCase));
  const r = await fuzz(reference, { fixture, timeLimitMs: LIMIT });
  assert.deepEqual([r.seed, r.count, r.genHash], [7, 10, genHash(generatorFile)]);
  assert.equal(r.divergences, 0);
  assert.deepEqual(r.classes, {});
  assert.deepEqual(r.excluded, { count: 0, examples: [] });
});

test('a variant that writes different bytes: <feature> / files, the example holds the case\'s and both sides\' files', E2E, async () => {
  const arm = toy(`v + '\\n'`, `v + '\\r\\n'`);
  const r = await fuzz(arm, { fixture, timeLimitMs: LIMIT });
  assert.deepEqual(r.classes, { 'append / files': 2, 'script / files': 2, 'new / files': 2 });
  assert.deepEqual(ids(r, 'append / files'), [1, 6]);
  const e = r.examples['append / files'][0];
  const c = cases[1];
  assert.deepEqual(e.case.args, c.args);
  assert.equal('log' in e.case, false);
  assert.deepEqual(rawTree(e.case.files), c.files);
  assert.deepEqual(e.env, { TOY_NOW: c.now, TOY_DIR: 'db', dirExisted: true });
  assert.deepEqual(rawTree(e.reference.files), { 'a.csv': Buffer.from('n\n1\n701\n'), 'old.csv': Buffer.from('y\n') });
  assert.deepEqual(rawTree(e.arm.files), { 'a.csv': Buffer.from('n\n1\n701\r\n'), 'old.csv': Buffer.from('y\n') });
  for (const s of [e.reference, e.arm]) assert.equal('log' in s, false);
  // the data directory did not exist before the run: created by the CLI on both sides
  const n = r.examples['new / files'][0];
  assert.deepEqual(n.case.files, {});
  assert.equal(n.env.dirExisted, false);
  assert.deepEqual(rawTree(n.reference.files), { 'b.csv': Buffer.from('704\n') });
});

test('a variant that creates an extra file or deletes one: <feature> / files', E2E, async () => {
  const extra = await fuzz(toy('// HOOK', `if (cmd === 'append') fs.writeFileSync(path.join(dir, 'extra.csv'), '');`), { fixture, timeLimitMs: LIMIT });
  assert.deepEqual(extra.classes, { 'append / files': 2, 'new / files': 2 });
  assert.deepEqual(Object.keys(rawTree(extra.examples['append / files'][0].arm.files)!), ['a.csv', 'extra.csv', 'old.csv']);
  const gone = await fuzz(toy('// HOOK', `if (cmd === 'append') fs.rmSync(path.join(dir, 'old.csv'), { force: true });`), { fixture, timeLimitMs: LIMIT });
  assert.deepEqual(gone.classes, { 'append / files': 2 });
  assert.deepEqual(Object.keys(rawTree(gone.examples['append / files'][0].arm.files)!), ['a.csv']);
});

test('a file outside the data directory is written but not compared', E2E, async () => {
  const ref = await runSide(path.join(reference, 'toy.mjs'), cases[3], LIMIT, names);
  assert.equal(ref.status, 0, ref.stderr.toString());
  assert.deepEqual(ref.files, { 'a.csv': Buffer.from('n\n703\n') }); // the script ran: it was written
  const r = await fuzz(toy('// HOOK', `fs.writeFileSync('script.sql', 'changed'); fs.writeFileSync('notes.txt', 'x');`), { fixture, timeLimitMs: LIMIT });
  assert.equal(r.divergences, 0, JSON.stringify(r.classes));
});

test('files: null gives no data directory on both sides; subdirectories are created', E2E, async () => {
  const cli = path.join(reference, 'toy.mjs');
  const none = await runSide(cli, cases[0], LIMIT, names);
  assert.equal(none.files, null);
  assert.equal(none.stdout.toString(), `${cases[0].now}\nno data\n`);
  const nested = await runSide(cli, cases[2], LIMIT, names);
  assert.equal(nested.stdout.toString(), `${cases[2].now}\nnested/deep.csv 3\n`);
  assert.deepEqual(nested.files, { 'nested/deep.csv': Buffer.from('z\n2\n3\n') });
  // an arm that prints something else on `count`: the examples keep null files on both sides
  const r = await fuzz(toy(`console.log('no data')`, `console.log('nothing')`), { fixture, timeLimitMs: LIMIT });
  assert.deepEqual(r.classes, { 'empty / stdout': 2 });
  const e = r.examples['empty / stdout'][0];
  assert.deepEqual([e.case.files, e.reference.files, e.arm.files, e.env.dirExisted], [null, null, null, false]);
});

test('the data directory read back: every file by forward-slash path, null when absent or not a directory', () => {
  const dir = spaced();
  assert.equal(readTree(path.join(dir, 'gone')), null);
  writeFileSync(path.join(dir, 'f'), 'x');
  assert.equal(readTree(path.join(dir, 'f')), null);
  mkdirSync(path.join(dir, 'd', 'b', 'c'), { recursive: true });
  mkdirSync(path.join(dir, 'd', 'empty'));
  assert.deepEqual(readTree(path.join(dir, 'd')), {});
  writeFileSync(path.join(dir, 'd', 'z.csv'), 'z');
  writeFileSync(path.join(dir, 'd', 'b', 'c', 'a.csv'), 'a');
  const t = readTree(path.join(dir, 'd'));
  assert.deepEqual(Object.keys(t), ['b/c/a.csv', 'z.csv']);
  assert.deepEqual(t['b/c/a.csv'], Buffer.from('a'));
});

test('files differ when the paths differ or any file\'s bytes differ; checked after stdout', () => {
  const r = (files: Record<string, Buffer> | null, o: object = {}) =>
    ({ stdout: Buffer.from('a'), stderr: Buffer.alloc(0), status: 0, signal: null, timedOut: false, files, ...o });
  const f = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  assert.equal(differs(r(null), r(null)), null);
  assert.equal(differs(r(f({})), r(f({}))), null);
  assert.equal(differs(r(f({ 'a.csv': '1', 'x/b.csv': '2' })), r(f({ 'x/b.csv': '2', 'a.csv': '1' }))), null);
  assert.equal(differs(r(f({})), r(null)), 'files');
  assert.equal(differs(r(null), r(f({ 'a.csv': '1' }))), 'files');
  assert.equal(differs(r(f({ 'a.csv': '1' })), r(f({ 'a.csv': '2' }))), 'files');
  assert.equal(differs(r(f({ 'a.csv': '1', 'b.csv': '' })), r(f({ 'a.csv': '1' }))), 'files');
  assert.equal(differs(r(f({ 'a.csv': '1' })), r(f({ 'b.csv': '1' }))), 'files');
  assert.equal(differs(r(f({ 'a.csv': '1' }), { stdout: Buffer.from('b') }), r(f({}))), 'stdout');
});
