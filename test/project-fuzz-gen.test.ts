// The blind case generator of the differential fuzz (bench/project-fuzz-gen.mjs, PRD #397): the same seed gives the
// same cases, every feature occurs, each case reaches exactly its own feature (checked by the plain rules below, written
// from bench/project/brief.md), the rounding cases' report rows, and the module's imports. Pure: spawns nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'bench', 'project-fuzz-gen.mjs');
const { FEATURES, DEFAULT_SEED, DEFAULT_COUNT, generate } = await import(pathToFileURL(file).href);

type Case = { id: number; feature: string; args: string[]; log: Buffer | null; now: string };
const cases: Case[] = generate();

// --- reading a case the way the brief describes the log --------------------------------------------------------------

const DAY = 1440;
/** Minutes of a valid `YYYY-MM-DDTHH:MM` (a real date and time), else null. */
function minutes(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59) return null;
  return Date.UTC(y, mo - 1, d, h, mi) / 60_000;
}
// A byte order mark and invalid UTF-8 are bom-utf8's: every other checker reads the text without them.
const clean = (s: string) => s.replace(/[﻿�]/g, '');
const logText = (c: Case) => (c.log ? clean(new TextDecoder('utf-8', { ignoreBOM: true }).decode(c.log)) : '');
function lines(c: Case): string[] {
  const t = logText(c);
  if (!t) return [];
  const ls = t.split(/\r\n|\r|\n/);
  if (ls.at(-1) === '') ls.pop();
  return ls;
}
const isBlank = (l: string) => l.trim() === '';
const isComment = (l: string) => l.startsWith('#');
const entryLines = (c: Case) => lines(c).filter((l) => !isBlank(l) && !isComment(l));
/** Start, end, project and note: fields split on runs of spaces and tabs, the note the rest without trailing ones. */
function fields(l: string) {
  const m = /^(\S+)(?:[ \t]+(\S+))?(?:[ \t]+(\S+))?(?:[ \t]+(.*?))?[ \t]*$/.exec(l) ?? [];
  return { start: m[1] ?? '', end: m[2] ?? '', project: m[3], note: m[4] ?? '' };
}
const logEntries = (c: Case) => entryLines(c).map(fields).filter((f) => f.project !== undefined);
/** The command line without its dash-led arguments (dash-args') and byte order marks (bom-utf8's). */
const core = (c: Case) => c.args.filter((a) => !a.startsWith('-')).map(clean);
const projectArg = (c: Case) => {
  const a = core(c);
  return (a[0] === 'start' || a[0] === 'add') && a.length > 1 ? a[1] : null;
};
const noteArgs = (c: Case) => {
  const a = core(c);
  return a[0] === 'start' ? a.slice(2) : a[0] === 'add' ? a.slice(4) : [];
};
/** Every valid time in the log's entry lines, the command line and TALLY_NOW. */
const times = (c: Case) =>
  [...entryLines(c).flatMap((l) => l.split(/[ \t]+/)), ...c.args.map(clean), c.now]
    .map(minutes)
    .filter((t): t is number => t !== null);

// --- the plain rule of each feature: true when the case keeps it ------------------------------------------------------

const NAME = /^[a-z][a-z0-9]*$/;
const WORDS = /^[a-z]+( [a-z]+)*$/;
const noCsv = (s: string) => s.replace(/[,"\r\n]/g, ''); // a comma, a quote or a line break in a note is csv-quoting's
const touch = (a: number[], b: number[]) => a[0] <= b[1] && b[0] <= a[1];

const keeps: Record<string, (c: Case) => boolean> = {
  'dash-args': (c) => !c.args.some((a) => a.startsWith('-') || a === '--'),
  spacing: (c) =>
    entryLines(c).every((l) => !/^[ \t]|[ \t]$/.test(l) && (l.match(/[ \t]+/g) ?? []).slice(0, 3).every((r) => r === ' ')),
  'blank-comment': (c) => lines(c).every((l) => !isBlank(l) && !isComment(l)),
  'line-endings': (c) => {
    const t = logText(c);
    return !t.includes('\r') && (t === '' || t.endsWith('\n'));
  },
  'bom-utf8': (c) => {
    if (c.args.some((a) => a.includes('﻿'))) return false;
    if (!c.log) return true;
    if (c.log.includes(Buffer.from([0xef, 0xbb, 0xbf]))) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(c.log);
      return true;
    } catch {
      return false;
    }
  },
  'missing-log': (c) => c.log !== null,
  'bad-now': (c) => minutes(c.now) !== null,
  overlap: (c) => {
    const now = minutes(c.now);
    const spans: number[][] = [];
    for (const f of logEntries(c)) {
      const s = minutes(f.start);
      const e = f.end === '-' ? now : minutes(f.end);
      if (s !== null && e !== null && e > s) spans.push([s, e]); // a wrong line is no entry
    }
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if (touch(spans[i], spans[j])) return false;
    if (now !== null && entryLines(c).flatMap((l) => l.split(/[ \t]+/)).some((t) => (minutes(t) ?? -Infinity) >= now)) return false;
    const a = core(c);
    if (a[0] !== 'add') return true;
    const [from, to] = [minutes(a[2] ?? ''), minutes(a[3] ?? '')];
    return from === null || to === null || to <= from || !spans.some((s) => touch(s, [from, to]));
  },
  running: (c) => logEntries(c).every((f) => f.end !== '-'),
  'names-notes': (c) => {
    const p = projectArg(c);
    return (
      logEntries(c).every((f) => NAME.test(f.project!) && (noCsv(f.note) === '' || WORDS.test(noCsv(f.note)))) &&
      (p === null || NAME.test(p)) &&
      noteArgs(c).every((n) => WORDS.test(noCsv(n)))
    );
  },
  rounding: (c) => times(c).every((t) => t % 15 === 0),
  'csv-quoting': (c) => [...logEntries(c).map((f) => f.note), ...noteArgs(c)].every((n) => !/[,"\r\n]/.test(n)),
};

// --- the report rows of the brief, unrounded ---------------------------------------------------------------------------

function rawRows(c: Case): number[] {
  const now = minutes(c.now)!;
  const spans = logEntries(c).map((f) => ({ project: f.project!, s: minutes(f.start)!, e: f.end === '-' ? now : minutes(f.end)! }));
  const [, kind, day = c.now.slice(0, 10)] = core(c);
  const within = (x: { s: number; e: number }, from: number, to: number) => Math.max(0, Math.min(x.e, to) - Math.max(x.s, from));
  const sums = new Map<string, number>();
  const add = (k: string, m: number) => sums.set(k, (sums.get(k) ?? 0) + m);
  const from = minutes(`${day}T00:00`)!;
  if (kind === 'project') for (const x of spans) add(x.project, x.e - x.s);
  if (kind === 'day') for (const x of spans) add(x.project, within(x, from, from + DAY));
  if (kind === 'week') {
    const monday = from - ((Math.floor(from / DAY) + 3) % 7) * DAY;
    for (let k = 0; k < 7; k++) for (const x of spans) add(String(k), within(x, monday + k * DAY, monday + (k + 1) * DAY));
  }
  return [...sums.values()].filter((m) => m > 0);
}

// --- the tests -----------------------------------------------------------------------------------------------------------

test('the defaults are seed 1107 and 1000 cases, with ids 0 to 999 in order', () => {
  assert.equal(DEFAULT_SEED, 1107);
  assert.equal(DEFAULT_COUNT, 1000);
  assert.equal(cases.length, 1000);
  assert.deepEqual(cases.map((c) => c.id), [...Array(1000).keys()]);
  assert.deepEqual(generate({ seed: 1107, count: 1000 }), cases);
  for (const c of cases) {
    assert.deepEqual(Object.keys(c), ['id', 'feature', 'args', 'log', 'now']);
    assert.ok(c.args.every((a) => typeof a === 'string') && typeof c.now === 'string');
    assert.ok(c.log === null || Buffer.isBuffer(c.log));
  }
});

test('the same seed and count give the same cases, byte for byte; another seed gives others', () => {
  const a = generate({ seed: 42, count: 300 });
  const b = generate({ seed: 42, count: 300 });
  assert.equal(a.length, 300);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((c: Case) => c.log && c.log.toString('hex')),
    b.map((c: Case) => c.log && c.log.toString('hex')),
  );
  assert.notDeepEqual(generate({ seed: 43, count: 300 }), a);
  assert.deepEqual(generate({ count: 0 }), []);
});

test('the twelve features in order, and every feature and plain occurs over the default cases', () => {
  assert.deepEqual(FEATURES, [
    'dash-args', 'spacing', 'blank-comment', 'line-endings', 'bom-utf8', 'missing-log',
    'bad-now', 'overlap', 'running', 'names-notes', 'rounding', 'csv-quoting',
  ]);
  const seen = new Set(cases.map((c) => c.feature));
  assert.deepEqual([...seen].sort(), [...FEATURES, 'plain'].sort());
});

test('the cases spread over every command of the brief', () => {
  const commands = new Set(cases.map((c) => {
    const a = core(c);
    return a[0] === 'report' ? `report ${a[1]}` : a[0];
  }));
  for (const c of ['start', 'stop', 'status', 'add', 'report day', 'report week', 'report project', 'overlaps', 'csv']) {
    assert.ok(commands.has(c), `no case runs ${c}`);
  }
});

/** The cases that do not reach exactly their own feature, as messages. */
function misses(list: Case[]): string[] {
  const wrong: string[] = [];
  for (const c of list) {
    for (const f of FEATURES) {
      if (keeps[f](c) !== (f !== c.feature)) wrong.push(`case ${c.id} (${c.feature}) ${f === c.feature ? 'keeps' : 'breaks'} ${f}`);
    }
  }
  return wrong;
}

test('each case breaks its own feature\'s plain rule and keeps every other one; a plain case breaks none', () => {
  assert.deepEqual(misses(cases).slice(0, 20), []);
});

test('one feature per case holds for other seeds too, and the rounding rows with it', () => {
  for (const seed of [1, 2, 99, 2024, 0xffffffff]) {
    const list: Case[] = generate({ seed, count: 500 });
    assert.deepEqual(misses(list).slice(0, 20), [], `seed ${seed}`);
    const bad = list.filter((c) => c.feature === 'rounding' && !rawRows(c).some((m) => m % 15 === 7 || m % 15 === 8));
    assert.deepEqual(bad.map((c) => c.id), [], `seed ${seed}`);
  }
});

test('every valid time outside the rounding cases is on a whole quarter hour', () => {
  const off = cases.filter((c) => c.feature !== 'rounding' && times(c).some((t) => t % 15 !== 0)).map((c) => c.id);
  assert.deepEqual(off, []);
});

test('every rounding case runs a report with a row whose raw minutes mod 15 is 7 or 8', () => {
  const rounding = cases.filter((c) => c.feature === 'rounding');
  assert.ok(rounding.length > 0);
  for (const c of rounding) {
    const a = core(c);
    assert.equal(a[0], 'report', `case ${c.id}`);
    assert.ok(['day', 'week', 'project'].includes(a[1]), `case ${c.id}: ${a.join(' ')}`);
    assert.ok(rawRows(c).some((m) => m % 15 === 7 || m % 15 === 8), `case ${c.id}: rows ${rawRows(c)}`);
  }
});

test('the generator imports only node: built-ins and names nothing under the reference or the hidden tests', () => {
  const src = readFileSync(file, 'utf8');
  const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:')), []);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /project[\\/]+(reference|hidden)/);
});
