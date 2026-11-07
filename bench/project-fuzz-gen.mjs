// The blind case generator of the project benchmark's differential fuzz (PRD #397): a seed and a count give the
// same `tally` cases on every machine. Written from bench/project/brief.md only, never from the reference. Pure: it
// spawns nothing, reads no clock and imports only node: built-ins, so its source hash changes only when the cases can.
//
// A case is { id, feature, args, log, now }: `args` the command line after `tally`, `log` the starting log (a Buffer,
// or null for no file), `now` the TALLY_NOW value. Each case reaches exactly one feature (or none: `plain`): it breaks
// that feature's plain rule and keeps every other one. Outside `rounding`, every valid time is on a quarter hour.
import { Buffer } from 'node:buffer';

export const FEATURES = [
  'dash-args', 'spacing', 'blank-comment', 'line-endings', 'bom-utf8', 'missing-log',
  'bad-now', 'overlap', 'running', 'names-notes', 'rounding', 'csv-quoting',
];
export const DEFAULT_SEED = 1107;
export const DEFAULT_COUNT = 1000;

// Each block of 100 cases holds 16 plain ones and 7 of each feature, in a seeded order.
const BLOCK = [...Array(16).fill('plain'), ...FEATURES.flatMap((f) => Array(7).fill(f))];

/** The `count` cases of `seed`, in case order. Case i depends only on the seed and i. */
export function generate({ seed = DEFAULT_SEED, count = DEFAULT_COUNT } = {}) {
  const cases = [];
  let order = [];
  for (let id = 0; id < count; id++) {
    if (id % BLOCK.length === 0) order = random(seed, id / BLOCK.length, 1).shuffle(BLOCK.slice());
    const feature = order[id % BLOCK.length];
    cases.push({ id, feature, ...BUILD[feature](random(seed, id, 0)) });
  }
  return cases;
}

// --- the PRNG: mulberry32 over a seed mixed with the case (or block) number -------------------------------------

function random(seed, n, salt) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const x of [n, salt]) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    weighted: (table) => {
      let x = next() * table.reduce((s, [, w]) => s + w, 0);
      for (const [v, w] of table) if ((x -= w) < 0) return v;
      return table.at(-1)[0];
    },
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    },
  };
  return r;
}

// --- time: whole minutes since 1970-01-01T00:00, written in the brief's format ------------------------------------

const DAY = 1440;
const pad = (n) => String(n).padStart(2, '0');
const date = (min) => {
  const d = new Date(Math.floor(min / DAY) * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const time = (min) => {
  const m = ((min % DAY) + DAY) % DAY;
  return `${date(min)}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const midnight = (y, m, d) => Date.UTC(y, m - 1, d) / 60_000;
const monday = (min) => {
  const day = Math.floor(min / DAY);
  return (day - ((day + 3) % 7)) * DAY; // 1970-01-01 was a Thursday
};

// Month ends, leap days, a year end and week edges, where date arithmetic goes wrong.
const ANCHORS = [
  [2024, 2, 28], [2024, 2, 29], [2023, 2, 28], [2024, 12, 31], [2023, 12, 31], [2024, 3, 31],
  [2024, 3, 4], [2025, 6, 29], [2024, 1, 1], [2024, 10, 27], [2025, 3, 30], [2024, 9, 30],
];
function baseDay(r) {
  if (r.chance(0.5)) return midnight(...r.pick(ANCHORS)) - DAY * r.int(0, 2);
  return midnight(2023, 1, 1) + DAY * r.int(0, 1460);
}

// --- plain material ------------------------------------------------------------------------------------------------

const PROJECTS = ['acme', 'beta', 'gamma', 'delta', 'web2', 'ops', 'x1', 'zeta9'];
const WORDS = ['fix', 'the', 'login', 'bug', 'standup', 'review', 'docs', 'call', 'plan', 'tests', 'deploy', 'team'];
const words = (r, max = 3) => Array.from({ length: r.int(0, max) }, () => r.pick(WORDS));
const note = (r, max = 4) => words(r, max).join(' ');
const line = (e) => `${time(e.start)} ${e.end == null ? '-' : time(e.end)} ${e.project}${e.note ? ` ${e.note}` : ''}`;
const text = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

/** A plain starting state: finished entries on quarter hours, 15 minutes or more apart, and now after them all. */
function base(r, { min = 0, max = 6 } = {}) {
  const day = baseDay(r);
  const entries = [];
  let t = day + 15 * r.int(0, 95);
  for (let i = r.int(min, max); i > 0; i--) {
    const start = t;
    const end = start + 15 * (r.chance(0.15) ? r.int(17, 64) : r.int(1, 16));
    entries.push({ start, end, project: r.pick(PROJECTS), note: note(r) });
    t = end + 15 * (r.chance(0.3) ? r.int(20, 300) : r.int(1, 12));
  }
  if (r.chance(0.1)) r.shuffle(entries); // a hand-edited log need not be in time order
  return { entries, running: null, now: t + 15 * r.int(0, 40), lines: entries.map(line) };
}

const lastTime = (st) => Math.max(...st.entries.map((e) => e.end), st.running?.start ?? -Infinity);

/** A from/to on quarter hours clear of every entry (a running one runs up to now); after now only when `future`. */
function slot(r, st, { future = true } = {}) {
  const busy = st.entries.map((e) => [e.start, e.end]);
  if (st.running) busy.push([st.running.start, st.now]);
  busy.sort((a, b) => a[0] - b[0]);
  const dur = 15 * r.int(1, 12);
  const first = busy.length ? busy[0][0] : st.now;
  const options = [first - dur - 15 * r.int(1, 40)];
  for (let i = 0; i + 1 < busy.length; i++) {
    const room = (busy[i + 1][0] - busy[i][1] - dur) / 15 - 1; // quarters of the gap left past 15 min each side
    if (room >= 1) options.push(busy[i][1] + 15 * r.int(1, room));
  }
  if (future) options.push(Math.max(st.now, ...busy.map((b) => b[1])) + 15 * r.int(1, 40));
  const from = r.pick(options);
  return [from, from + dur];
}

/** A day the state touches (an entry's start or end, or now), sometimes a few days off. */
function someDay(r, st) {
  const times = [...st.entries.flatMap((e) => [e.start, e.end]), ...(st.running ? [st.running.start] : []), st.now];
  return r.pick(times) + (r.chance(0.15) ? DAY * r.int(-10, 10) : 0);
}

/** A time in the brief's shape (or nearly) that is not a valid time; its minutes stay on the quarter hour. */
function unreal(r, min) {
  const [y, mo, d] = date(min).split('-');
  const hm = time(min).slice(11);
  return r.pick([
    `${y}-${mo}-${d}T24:00`, `${y}-13-${d}T${hm}`, `${y}-${mo}-32T${hm}`, `${y}-02-30T${hm}`,
    `${y}-04-31T${hm}`, `${y}-00-${d}T${hm}`, `${y}-${mo}-${d}T9:15`, `${y}-${mo}-${d}T${hm}:00`,
  ]);
}

// The commands a case runs, by weight; `error` is a usage error (unknown command, missing or bad argument).
const COMMANDS = [
  ['start', 12], ['stop', 5], ['status', 7], ['add', 14], ['day', 10], ['week', 10], ['project', 10],
  ['overlaps', 8], ['csv', 12], ['error', 12],
];
const NO_ERROR = COMMANDS.filter(([c]) => c !== 'error');

function command(r, st, kind) {
  const p = r.pick(PROJECTS);
  switch (kind) {
    case 'start': return ['start', p, ...words(r)];
    case 'stop': return ['stop'];
    case 'status': return ['status'];
    case 'add': {
      const [from, to] = slot(r, st);
      return ['add', p, time(from), time(to), ...words(r)];
    }
    case 'day': return ['report', 'day', ...(r.chance(0.7) ? [date(someDay(r, st))] : [])];
    case 'week': return ['report', 'week', ...(r.chance(0.7) ? [date(someDay(r, st))] : [])];
    case 'project': return ['report', 'project'];
    case 'overlaps': return ['overlaps'];
    case 'csv': return ['csv'];
    default: {
      const [from, to] = slot(r, st);
      const y = date(st.now).slice(0, 4);
      return r.pick([
        [], ['foo'], ['Start', p], ['report'], ['report', 'month'], ['report', 'day', `${y}-02-30`],
        ['report', 'week', 'soon'], ['report', 'day', `${y}-3-4`], ['start'], ['add', p], ['add', p, time(from)],
        ['add', p, time(to), time(from)], ['add', p, time(from), time(from)], ['add', p, unreal(r, from), time(to)],
        ['add', p, time(from), 'later'],
      ]);
    }
  }
}

/** A line the strict reading rejects, on times clear of every entry and before now. */
function wrongLine(r, st) {
  const [from, to] = slot(r, st, { future: false });
  const p = r.pick(PROJECTS);
  return r.pick([
    `${time(from)} ${time(to)}`, `${time(from)}`, `${time(to)} ${time(from)} ${p}`, `${time(from)} ${time(from)} ${p}`,
    `${time(from)} ${unreal(r, to)} ${p}`, `${unreal(r, from)} ${time(to)} ${p}`,
  ]);
}

const insert = (r, xs, x) => xs.splice(r.int(0, xs.length), 0, x);
const done = (st, args, { log = Buffer.from(text(st.lines)), now = time(st.now) } = {}) => ({ args, log, now });

// --- one builder per feature ---------------------------------------------------------------------------------------

const DASHES = ['--', '-', '-h', '--help', '-v', '--version', '-n', '-x', '-acme', '--note', '--force', '-1'];
const RUNS = ['  ', '\t', ' \t', '\t ', '   ', '\t\t'];
const TRAILING = [' ', '\t', '  ', ' \t'];
const INVALID = [[0xff], [0xfe], [0xc3], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0x80], [0xf4, 0x90, 0x80, 0x80]];
const ODD_NAMES = [
  'Acme', 'ACME', 'Beta', 'client-2.web', 'a_b', '9lives', 'acme.', 'a-', 'acme_2', 'x.y.z', 'a--b', '0',
  'ac!me', '.acme', '_acme', 'ac/me', 'acmé', 'über', 'ac:me', 'Ω',
];
const ODD_NOTES = [
  'Fixed the Login', 'fix: login', 'v2.0 release', 'café ☕', 'tab\tinside', 'two  spaces', '100%', '(wip)',
  'emoji 🎉', '#hash', "it's done", 'a;b', '-', '- dash', 'ünïcödé', 'TODO', '日本語 メモ', 'back\\slash', '$HOME',
];
const ODD_ARG_NOTES = [
  ['Fix', 'Login'], ['fix  login'], [''], ['café'], ['#tag'], ['a;b'], ['Ω'], ['fix', ''], ['tab\tinside'],
  [' leading'], ['trailing '], ['v2.0'],
];
const CSV_NOTES = [
  'fixed login, again', 'say "hi"', '"quoted"', 'a,b,c', '""', ',', 'x"y', 'the "big", one', 'one, two, three', '"',
  'end,',
];
const CSV_ARG_NOTES = [
  ['fixed login, again'], ['say', '"hi"'], ['line\nbreak'], ['crlf\r\nbreak'], ['cr\rbreak'], ['a,b'],
  ['he said "no"'], ['trailing\n'],
];

/** `l` with its first three field separators or its end made unusual (at least one of them). */
function respace(r, l) {
  const t = l.split(' ');
  const seps = Math.min(3, t.length - 1);
  const forced = r.int(0, seps); // `seps` itself is the trailing slot
  const run = (i) => (i === forced || r.chance(0.3) ? r.pick(RUNS) : ' ');
  const s = Array.from({ length: seps }, (_, i) => run(i));
  const tail = forced === seps || r.chance(0.3) ? r.pick(TRAILING) : '';
  return `${t[0]}${s[0]}${t[1]}${s[1]}${t[2]}${t.length > 3 ? `${s[2]}${t.slice(3).join(' ')}` : ''}${tail}`;
}

/** Rewrites the project or the note of one entry line in place. */
function setField(st, i, field, value) {
  const at = st.lines.indexOf(line(st.entries[i])); // the line is still its plain rendering
  st.entries[i] = { ...st.entries[i], [field]: value };
  st.lines[at] = line(st.entries[i]);
}

const BUILD = {
  plain(r) {
    const st = base(r);
    if (r.chance(0.1)) insert(r, st.lines, wrongLine(r, st));
    return done(st, command(r, st, r.weighted(COMMANDS)));
  },

  'dash-args'(r) {
    const st = base(r);
    const args = command(r, st, r.weighted(COMMANDS));
    for (let n = r.int(1, 2); n > 0; n--) insert(r, args, r.pick(DASHES));
    return done(st, args);
  },

  spacing(r) {
    const st = base(r, { min: 1 });
    const n = r.int(1, st.lines.length);
    for (const i of r.shuffle(st.lines.map((_, i) => i)).slice(0, n)) st.lines[i] = respace(r, st.lines[i]);
    return done(st, command(r, st, r.weighted(COMMANDS)));
  },

  'blank-comment'(r) {
    const st = base(r);
    const entryLines = st.lines.slice();
    for (let n = r.int(1, 3); n > 0; n--) {
      const kind = r.pick(['blank', 'blank', 'comment', 'comment', 'entry']);
      const comment = r.pick(['#', `# ${note(r) || 'todo'}`, `#${r.pick(WORDS)}`, `## ${r.pick(WORDS)}`]);
      const l = kind === 'blank' ? '' : kind === 'entry' && entryLines.length ? `# ${r.pick(entryLines)}` : comment;
      insert(r, st.lines, l);
    }
    return done(st, command(r, st, r.weighted(COMMANDS)));
  },

  'line-endings'(r) {
    const st = base(r, { min: 1 });
    const n = st.lines.length;
    const eol = Array(n).fill('\n');
    const variant = r.pick(['crlf', 'some-crlf', 'cr', 'no-final', 'crlf-no-final', 'cr-final']);
    if (variant === 'crlf' || variant === 'crlf-no-final') eol.fill('\r\n');
    if (variant === 'some-crlf') for (let k = r.int(1, n); k > 0; k--) eol[r.int(0, n - 1)] = '\r\n';
    if (variant === 'cr') eol[r.int(0, n - 1)] = '\r';
    if (variant === 'no-final' || variant === 'crlf-no-final') eol[n - 1] = '';
    if (variant === 'cr-final') eol[n - 1] = '\r';
    const log = Buffer.from(st.lines.map((l, i) => l + eol[i]).join(''));
    return done(st, command(r, st, r.weighted(COMMANDS)), { log });
  },

  'bom-utf8'(r) {
    const st = base(r, { min: 1 });
    const args = command(r, st, r.weighted(COMMANDS));
    const variant = r.pick(['bom', 'bom', 'bom-line', 'invalid', 'invalid', 'invalid', 'arg']);
    if (variant === 'arg' && args.length) {
      const i = r.int(0, args.length - 1);
      args[i] = r.chance(0.7) ? `﻿${args[i]}` : `${args[i]}﻿`;
      return done(st, args);
    }
    if (variant === 'bom-line' && st.lines.length > 1) {
      const i = r.int(1, st.lines.length - 1);
      st.lines[i] = `﻿${st.lines[i]}`;
      return done(st, args);
    }
    if (variant === 'invalid') {
      // The bytes go inside or after the line's last word (the note's, or the project), never between fields.
      const i = r.int(0, st.lines.length - 1);
      const l = st.lines[i];
      const at = r.int(l.lastIndexOf(' ') + 2, l.length);
      const bytes = (s) => Buffer.from(text(s));
      const log = Buffer.concat([
        bytes(st.lines.slice(0, i)), Buffer.from(l.slice(0, at)), Buffer.from(r.pick(INVALID)),
        Buffer.from(`${l.slice(at)}\n`), bytes(st.lines.slice(i + 1)),
      ]);
      return done(st, args, { log });
    }
    return done(st, args, { log: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text(st.lines))]) });
  },

  'missing-log'(r) {
    const st = base(r, { max: 0 });
    return done(st, command(r, st, r.weighted(NO_ERROR)), { log: null });
  },

  'bad-now'(r) {
    const st = base(r);
    const t = time(st.now);
    const d = date(st.now);
    const y = d.slice(0, 4);
    const now = r.pick([
      t.replace('T', ' '), `${t}:00`, `${t}Z`, `${t}+02:00`, d, `${d}T24:00`, `${t.slice(0, 14)}60`, `${y}-02-30T10:00`,
      `${y}-13-01T09:00`, `${y}-00-10T09:00`, `${d.slice(0, 8)}00T09:00`, `${y}-04-31T09:00`, '2023-02-29T09:00',
      t.replace('T', 't'), ` ${t}`, `${t} `, 'now', 'yesterday', '0', 'T', t.slice(0, -1), `${d}T9:15`,
      t.replaceAll('-', '/'), `${t}:00.000`,
    ]);
    return done(st, command(r, st, r.weighted(COMMANDS)), { now });
  },

  overlap(r) {
    const st = base(r, { min: 1 });
    const e = r.pick(st.entries);
    const d = 15 * r.int(1, 8);
    const len = (e.end - e.start) / 15;
    const [from, to] = r.pick([
      [e.end, e.end + d], [e.start - d, e.start], [e.start, e.end], [e.start - d, e.end + d],
      [e.start + 15 * r.int(0, len - 1), e.end + d], len > 1 ? [e.start + 15, e.end - 15 * (len > 2 ? 1 : 0)] : [e.start, e.end],
    ]);
    const variant = r.pick(['log', 'log', 'add', 'now']);
    if (variant === 'add') return done(st, ['add', r.pick(PROJECTS), time(from), time(to), ...words(r)]);
    if (variant === 'now') {
      const first = Math.min(...st.entries.map((x) => x.start));
      st.now = r.pick([lastTime(st), e.start, e.end, (e.start + e.end) / 2 - (((e.start + e.end) / 2) % 15), first - d]);
      const kind = r.weighted([['start', 50], ['status', 10], ['day', 10], ['overlaps', 10], ['project', 10], ['csv', 5], ['add', 5]]);
      return done(st, command(r, st, kind));
    }
    const added = { start: from, end: to, project: r.pick(PROJECTS), note: note(r) };
    st.entries.push(added);
    insert(r, st.lines, line(added));
    st.now = Math.max(st.now, to + 15 * r.int(1, 8));
    return done(st, r.chance(0.45) ? ['overlaps'] : command(r, st, r.weighted(NO_ERROR)));
  },

  running(r) {
    const st = base(r);
    const start = st.now + 15 * r.int(1, 12);
    st.running = { start, project: r.pick(PROJECTS), note: note(r) };
    st.now = start + 15 * r.int(1, 60);
    const l = line({ ...st.running, end: null });
    if (r.chance(0.7)) st.lines.push(l);
    else insert(r, st.lines, l);
    const kind = r.weighted([
      ['stop', 35], ['status', 15], ['start', 10], ['day', 8], ['week', 6], ['project', 6], ['csv', 8], ['overlaps', 5], ['add', 7],
    ]);
    return done(st, command(r, st, kind));
  },

  'names-notes'(r) {
    const st = base(r, { min: 1 });
    const variant = r.pick(['log-name', 'log-name', 'log-note', 'log-note', 'arg-name', 'arg-note']);
    if (variant === 'arg-name' || variant === 'arg-note') {
      const p = variant === 'arg-name' ? r.pick(ODD_NAMES.filter((n) => !n.startsWith('-'))) : r.pick(PROJECTS);
      const notes = variant === 'arg-note' ? r.pick(ODD_ARG_NOTES) : words(r);
      if (r.chance(0.5)) return done(st, ['start', p, ...notes]);
      const [from, to] = slot(r, st);
      return done(st, ['add', p, time(from), time(to), ...notes]);
    }
    for (let n = r.int(1, Math.min(2, st.entries.length)); n > 0; n--) {
      const i = r.int(0, st.entries.length - 1);
      if (variant === 'log-name') setField(st, i, 'project', r.pick([...ODD_NAMES, '-acme']));
      else setField(st, i, 'note', r.pick(ODD_NOTES));
    }
    const kind = r.weighted([['project', 30], ['day', 10], ['week', 5], ['csv', 20], ['overlaps', 5], ['status', 5], ['start', 10], ['add', 15]]);
    return done(st, command(r, st, kind));
  },

  rounding(r) {
    const kind = r.pick(['day', 'week', 'project']);
    const D = baseDay(r);
    const P = r.pick(PROJECTS);
    const others = PROJECTS.filter((p) => p !== P);
    // The target row: one project's time on day D (day), all time on D (week) or one project's (project), whose
    // total mod 15 is 7 or 8, split into 1 to 3 entries starting off the quarter hour.
    const total = 15 * r.int(0, 6) + r.pick([7, 8]);
    const parts = [];
    for (let left = total, m = Math.min(r.int(1, 3), total); m > 0; m--) {
      const p = m === 1 ? left : r.int(1, left - m + 1);
      parts.push(p);
      left -= p;
    }
    const loose = (from, until, projects) => {
      const out = [];
      for (let t = from + r.int(1, 120); out.length < 4; ) {
        const start = t;
        const end = start + r.int(1, 200);
        if (end >= until) break;
        out.push({ start, end, project: r.pick(projects), note: note(r, 2) });
        t = end + r.int(1, 600);
      }
      return out;
    };
    const entries = loose(D - DAY * r.int(1, 3), D, kind === 'project' ? others : PROJECTS);
    let c = D + r.int(360, 600);
    if (c % 15 === 0) c += r.int(1, 14);
    for (const p of parts) {
      entries.push({ start: c, end: c + p, project: kind === 'week' ? r.pick(PROJECTS) : P, note: note(r, 2) });
      c += p + r.int(1, 90);
    }
    const defaulted = r.chance(0.3);
    if (kind !== 'week') entries.push(...loose(c, D + DAY, others));
    if (!(defaulted && kind === 'day')) entries.push(...loose(D + DAY, D + DAY * 4, kind === 'project' ? others : PROJECTS));
    let now = Math.max(...entries.map((e) => e.end)) + r.int(1, 120);
    now += (15 - (now % 15)) % 15;
    let args = ['report', 'project'];
    if (kind === 'day') args = ['report', 'day', ...(defaulted && date(now) === date(D) ? [] : [date(D)])];
    if (kind === 'week') {
      const any = monday(D) + DAY * r.int(0, 6);
      args = ['report', 'week', ...(defaulted && monday(now) === monday(D) ? [] : [date(any)])];
    }
    return done({ lines: entries.map(line), now }, args);
  },

  'csv-quoting'(r) {
    const st = base(r, { min: 1 });
    if (r.chance(0.3)) {
      const notes = r.pick(CSV_ARG_NOTES);
      if (r.chance(0.5)) return done(st, ['start', r.pick(PROJECTS), ...notes]);
      const [from, to] = slot(r, st);
      return done(st, ['add', r.pick(PROJECTS), time(from), time(to), ...notes]);
    }
    for (let n = r.int(1, Math.min(3, st.entries.length)); n > 0; n--) setField(st, r.int(0, st.entries.length - 1), 'note', r.pick(CSV_NOTES));
    const kind = r.weighted([['csv', 75], ['start', 5], ['add', 5], ['project', 5], ['status', 5], ['overlaps', 5]]);
    return done(st, command(r, st, kind));
  },
};
