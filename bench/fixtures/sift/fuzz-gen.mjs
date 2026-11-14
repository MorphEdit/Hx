// The blind case generator of the `sift` fixture's differential fuzz (PRD #446): a seed and a count give the same
// cases on every machine. Written from bench/fixtures/sift/brief.md and change.md only, never from a reference, and it
// expects the final product (brief + change). Pure: it spawns nothing, reads no clock and imports only node: built-ins,
// so its source hash changes only when the cases can.
//
// A case is a directory case { id, feature, args, files, now }: `args` the command line after `sift`, `files` the
// case's files by forward-slash path relative to its directory (the tables under the data directory `db/`, the
// manifest's fuzzFile; a script for `sift run` outside it) as Buffers, or null for none, `now` the SIFT_TODAY value.
// Each case stresses one feature and keeps every other rule. A behaviour the brief and change leave open is never
// reached; the ones met on the way, and how they are kept out:
// - error wording (only the exit code, stdout and whether stderr is empty are compared);
// - a bare NULL inside arithmetic or a function (its type is open): typed NULLs are `CAST(NULL AS <type>)`;
// - SUBSTR or ROUND with a NULL and a bad argument together, ROUND of an integer with a bad `d`: never generated;
// - an UPDATE that sets a row to the values it had (written again or not): an UPDATE's table and every table of a
//   script that may succeed are in sift's own file form, so writing them again changes no byte;
// - SUM or AVG past the decimal range, ROUND past it, WEEKDAY or day counts before the Gregorian calendar: none;
// - a non-table file whose name differs from a table's only in case (Windows sees one file): never both.
// The brief now states what is worked out after a HAVING or an UPDATE's WHERE drops something, that IN works out every
// item and CASE stops at its first match, and the order of `sift tables`; the cases still keep away from them (those
// expressions cannot fail at run time, a text compared with a date in IN, BETWEEN or CASE is always a date, and no two
// table names differ only between `_` and a letter).
import { Buffer } from 'node:buffer';

export const FEATURES = [
  'expressions', 'division', 'decimals', 'casts', 'coercion', 'three-valued', 'like', 'distinct', 'where', 'order-by',
  'limit', 'aggregates', 'grouping', 'joins', 'subqueries', 'text-functions', 'number-functions', 'date-functions',
  'case', 'union', 'insert', 'update', 'delete', 'create-drop', 'scripts', 'formats', 'csv-reading', 'table-errors',
  'boundaries', 'syntax', 'lexing', 'type-errors', 'names', 'aggregate-errors', 'usage', 'environment', 'precedence',
  'commands', 'non-tables',
];
export const DEFAULT_SEED = 1107;
export const DEFAULT_COUNT = 1000;

// Each block of 88 cases holds 10 plain ones and 2 of each feature, in a seeded order.
const BLOCK = [...Array(10).fill('plain'), ...FEATURES.flatMap((f) => [f, f])];

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
    shuffle: (xs) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    },
    some: (xs, lo, hi) => r.shuffle(xs.slice()).slice(0, r.int(lo, Math.min(hi, xs.length))),
  };
  return r;
}

// --- values, as sift prints them -----------------------------------------------------------------------------------

const TYPES = ['integer', 'decimal', 'text', 'boolean', 'date'];
const MAX_INT = '9223372036854775807';
const MIN_INT = '-9223372036854775808';
const BIG_DEC = '999999999999999999.999999';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const mdays = (y, m) => (m === 2 && leap(y) ? 29 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]);
const ymd = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
function someDate(r, lo = 1999, hi = 2026) {
  const y = r.int(lo, hi), m = r.int(1, 12);
  return ymd(y, m, r.int(1, mdays(y, m)));
}
const EDGE_DATES = ['2024-02-29', '2000-02-29', '1999-12-31', '2024-01-31', '2023-12-31', '2024-03-01', '2023-02-28', '2024-12-31'];
const someDay = (r) => (r.chance(0.3) ? r.pick(EDGE_DATES) : someDate(r));
const today = (r) => someDate(r, 2023, 2025);

/** A decimal as sift prints it: no leading zeros, at least one digit after the point, zero never negative. */
function decimal(neg, int, frac) {
  const i = String(int).replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '') || '0';
  return `${neg && !(i === '0' && f === '0') ? '-' : ''}${i}.${f}`;
}
const FRACS = ['', '5', '25', '125', '99', '05', '000001', '333333', '75', '1', '000005'];
const someDecimal = (r, neg = 0.2) => decimal(r.chance(neg), r.pick([0, 0, 1, 2, 5, 10, 12, 99, 100, 250, 1999, r.int(0, 9999)]),
  r.chance(0.2) ? pad(r.int(0, 999999), 6) : r.pick(FRACS));
const someInt = (r) => String(r.pick([0, 1, 2, 3, 5, 7, 10, 12, 42, 100, -1, -3, -7, r.int(-50, 500)]));

// Texts: case, padding, CSV specials, line breaks, a `|`, LIKE's wildcards, and texts that look like other types.
const WORDS = [
  'apple', 'Apple', 'APPLE', 'banana', 'Cherry', 'cherry pie', '', ' pad ', 'pear, green', 'say "hi"', 'two\nlines',
  'cr\r\nlf', 'tab\there', 'é', 'Zoë', '100', '-7', '007', '1.5', 'true', '2024-01-05', 'x|y', '50%', 'a_b', 'NULL', 'z',
  'ab', 'b', 'B', 'it\'s',
];
const CITIES = ['Paris', 'paris', 'Oslo', 'São Paulo', 'New York, NY', 'Rome', '', 'Zürich', 'lagos'];

// --- the data directory's model: tables { name, cols: [{ name, type, kind }], rows: [[value]] }, values as printed --

const SHAPES = {
  cities: [['name', 'text', 'city'], ['pop', 'integer', 'num'], ['founded', 'date', 'day', 1], ['capital', 'boolean', 'flag', 1]],
  events: [['id', 'integer', 'id'], ['day', 'date', 'day'], ['kind', 'text', 'word'], ['amount', 'decimal', 'money', 1], ['count', 'integer', 'num', 1]],
  people: [['id', 'integer', 'id'], ['name', 'text', 'word'], ['city', 'text', 'city', 1], ['born', 'date', 'day', 1], ['active', 'boolean', 'flag', 1], ['score', 'decimal', 'money', 1]],
  orders: [['id', 'integer', 'id'], ['person_id', 'integer', 'fk:people'], ['total', 'decimal', 'money'], ['placed', 'date', 'day', 1], ['paid', 'boolean', 'flag', 1], ['note', 'text', 'word', 1]],
  items: [['id', 'integer', 'id'], ['order_id', 'integer', 'fk:orders'], ['name', 'text', 'word'], ['qty', 'integer', 'num'], ['price', 'decimal', 'money', 1]],
};
// names sift may create; none differs from another table's name, or from a non-table file's, only by case or `_`
const NEW_NAMES = ['tags', 'stock', 'log2024', 'archive2', 'tmp'];

function value(r, kind, db) {
  if (kind !== 'id' && r.chance(0.15)) return null;
  if (kind.startsWith('fk:')) {
    const parent = db.tables.find((t) => t.name === kind.slice(3));
    const ids = parent ? parent.rows.map((row) => row[0]).filter((v) => v !== null) : [];
    return ids.length && r.chance(0.85) ? r.pick(ids) : String(r.int(1, 9));
  }
  switch (kind) {
    case 'num': return someInt(r);
    case 'money': return someDecimal(r);
    case 'word': return r.pick(WORDS);
    case 'city': return r.pick(CITIES);
    case 'flag': return r.pick(['true', 'false']);
    case 'day': return someDay(r);
  }
  throw new Error(`kind ${kind}`);
}

function makeTable(r, name, db, rows = r.chance(0.08) ? 0 : r.int(1, 7)) {
  const cols = SHAPES[name].filter((c) => !c[3] || r.chance(0.6)).map(([n, type, kind]) => ({ name: n, type, kind }));
  const t = { name, cols, rows: [] };
  for (let i = 0; i < rows; i++) {
    t.rows.push(cols.map((c) => (c.kind === 'id' ? (r.chance(0.05) ? r.pick([null, '1']) : String(i + 1)) : value(r, c.kind, db))));
  }
  return t;
}

/** A data directory of `min`–`max` tables (parents before children, so foreign keys mostly match). */
function makeDb(r, min = 1, max = 3) {
  const db = { tables: [] };
  const names = r.some(Object.keys(SHAPES), min, max);
  for (const name of Object.keys(SHAPES)) if (names.includes(name)) db.tables.push(makeTable(r, name, db));
  return db;
}

const KINDS = { integer: 'num', decimal: 'money', text: 'word', boolean: 'flag', date: 'day' };
/** A table of one column, a shape the others never have (an empty line is a row holding NULL). */
function oneColumn(r, name = 'tags') {
  const type = r.pick(TYPES);
  const kind = KINDS[type];
  const t = { name, cols: [{ name: r.pick(['v', 'tag', 'x']), type, kind }], rows: [] };
  for (let i = r.int(0, 5); i > 0; i--) t.rows.push([value(r, kind, { tables: [] })]);
  return t;
}

// --- table files ---------------------------------------------------------------------------------------------------

const needsQuote = (s) => /[",\r\n]/.test(s);
const quote = (s) => `"${s.replace(/"/g, '""')}"`;
const field = (type, v) => (v === null ? '' : type === 'text' && v === '' ? '""' : needsQuote(v) ? quote(v) : v);

/** A table's file in sift's own form (header lower case, `\n` after every line), or, with `r`, in a looser form a
 *  person may write: quoted fields, CRLF, a BOM, no final line break, leading zeros, `5` for `5.0`, types in capitals. */
function tableText(t, r = null) {
  const header = t.cols.map((c) => {
    if (!r) return `${c.name}:${c.type}`;
    return `${r.chance(0.2) ? c.name.toUpperCase() : c.name}:${r.pick([c.type, c.type, c.type.toUpperCase(), c.type[0].toUpperCase() + c.type.slice(1)])}`;
  }).join(',');
  const lines = [header, ...t.rows.map((row) => row.map((v, i) => (r ? looseField(r, t.cols[i].type, v) : field(t.cols[i].type, v))).join(','))];
  const eol = r && r.chance(0.4) ? '\r\n' : '\n';
  let s = lines.join(eol) + eol;
  if (r && r.chance(0.25) && lines.at(-1) !== '') s = s.slice(0, -eol.length);
  return (r && r.chance(0.2) ? '﻿' : '') + s;
}

function looseField(r, type, v) {
  if (v === null) return type !== 'text' && r.chance(0.3) ? '""' : '';
  if (type === 'text' && v === '') return '""';
  let s = v;
  if (type === 'integer' && s.replace('-', '').length < 18 && r.chance(0.3)) s = s === '0' ? r.pick(['-0', '00']) : s.replace(/^(-?)/, `$1${'0'.repeat(r.int(1, 2))}`);
  if (type === 'decimal' && r.chance(0.4)) {
    const [i, f] = s.split('.');
    s = f === '0' && r.chance(0.5) ? (i === '0' && r.chance(0.5) ? '-0' : i) : `${i}.${f.padEnd(Math.min(6, f.length + r.int(1, 3)), '0')}`;
  }
  return needsQuote(s) || r.chance(0.25) ? quote(s) : s;
}

// Files in the data directory that are not tables (capital letters, a digit first, a reserved word, a dot first, another
// extension, a subfolder): sift never reads, changes or deletes them. Broken on purpose where that would show.
const EXTRAS = {
  'db/notes.txt': 'not a table\n', 'db/Archive.csv': 'id:integer\n1\n', 'db/2019.csv': 'id:integer\n1\n', 'db/select.csv': 'a:text\nx\n',
  'db/.hidden.csv': 'a:text\n"\n', 'db/old/orders.csv': 'id:integer\n9\n', 'db/people.csv.bak': 'garbage"\n', 'db/Mixed_Case.csv': 'a:integer\nx\n',
};

/** The case's files: every table under db/ (loose ones in `loose`), the extras chosen, and more files (a script). */
function files(r, db, { loose = [], extras = 0, more = {} } = {}) {
  const out = {};
  for (const t of db.tables) out[`db/${t.name}.csv`] = Buffer.from(tableText(t, loose.includes(t.name) ? r : null));
  if (extras) for (const k of r.some(Object.keys(EXTRAS), 1, extras)) out[k] = Buffer.from(EXTRAS[k]);
  if (!db.tables.length && !Object.keys(out).some((k) => k.startsWith('db/'))) out['db/.keep'] = Buffer.alloc(0);
  for (const [k, v] of Object.entries(more)) out[k] = Buffer.from(v);
  return out;
}
const looseAll = (r, db, p = 0.5) => db.tables.filter(() => r.chance(p)).map((t) => t.name);

// --- expressions: { s, t, p } — the SQL, its type, its binding (1 OR … 8 an atom); `col` on a column reference ------

const E = (s, t, p = 8) => ({ s, t, p });
const wrap = (e, need) => (e.p < need ? `(${e.s})` : e.s);
const bin = (a, op, b, t, p) => E(`${wrap(a, p)} ${op} ${wrap(b, p + 1)}`, t, p);
const cmp = (a, op, b) => E(`${wrap(a, 5)} ${op} ${wrap(b, 5)}`, 'boolean', 4);
const neg = (a) => E(`-${wrap(a, 8)}`, a.t, 7);
const call = (name, t, ...args) => E(`${name}(${args.map((a) => a.s).join(', ')})`, t);
const typeName = (r, t) => r.pick([t.toUpperCase(), t.toUpperCase(), t, t[0].toUpperCase() + t.slice(1)]);
const cast = (r, e, t) => E(`CAST(${e.s} AS ${typeName(r, t)})`, t);
const str = (s) => `'${s.replace(/'/g, "''")}'`;
const NULL = E('NULL', null);
const typedNull = (r, t) => E(`CAST(NULL AS ${typeName(r, t)})`, t);
const dateLit = (r, d = someDay(r)) => E(`CAST(${str(d)} AS DATE)`, 'date');

function literal(r, t) {
  switch (t) {
    case 'integer': return E(String(r.pick([0, 1, 2, 3, 4, 5, 7, 10, 12, 100, 1000, r.int(0, 60)])), t);
    case 'decimal': return E(someDecimal(r, 0), t);
    case 'text': return E(str(r.pick(WORDS)), t);
    case 'boolean': return E(r.pick(['TRUE', 'FALSE']), t);
    case 'date': return r.chance(0.2) ? E('TODAY()', t) : dateLit(r);
  }
  throw new Error(`type ${t}`);
}

/** A model value as an SQL expression: dates as text half the time (assigned and compared as dates). */
function sqlValue(r, type, v) {
  if (v === null) return NULL;
  if (type === 'integer') return v === MIN_INT ? E(`-${MAX_INT} - 1`, type, 5) : E(v, type, v.startsWith('-') ? 7 : 8);
  if (type === 'decimal') return E(v, type, v.startsWith('-') ? 7 : 8);
  if (type === 'text') return E(str(v), type);
  if (type === 'boolean') return E(v.toUpperCase(), type);
  return r.chance(0.5) ? E(str(v), 'text') : dateLit(r, v);
}

// A context: `leaves` the column references (or GROUP BY items) by type, `raw` the context of an aggregate's argument
// (set in a grouped query), `risky` whether run-time errors may be met, `db` and `sub` for subqueries.
const noLeaves = () => ({ integer: [], decimal: [], text: [], boolean: [], date: [] });
const anyType = (r, cx) => {
  const have = TYPES.filter((t) => cx.leaves[t].length);
  return have.length && r.chance(0.7) ? r.pick(have) : r.pick(TYPES);
};
const num = (r) => r.pick(['integer', 'decimal']);
const small = (r, cx) => (cx.leaves.integer.length && r.chance(0.4) ? r.pick(cx.leaves.integer) : E(String(r.int(0, 400)), 'integer'));

function gen(r, cx, t, d) {
  if (d > 0 && !r.chance(0.2)) {
    for (let k = 0; k < 6; k++) {
      const e = r.pick(MAKE[t])(r, cx, d - 1);
      if (e) return e;
    }
  }
  return leaf(r, cx, t);
}

function leaf(r, cx, t) {
  if (cx.leaves[t].length && r.chance(0.75)) return r.pick(cx.leaves[t]);
  if (cx.raw && r.chance(0.6)) return aggregate(r, cx, t);
  return r.chance(0.08) ? typedNull(r, t) : literal(r, t);
}

function aggregate(r, cx, t) {
  const arg = (tt) => gen(r, cx.raw, tt, r.int(0, 1)).s;
  const minmax = r.pick(['MIN', 'MAX']);
  if (t === 'integer') return E(r.pick([() => 'COUNT(*)', () => `COUNT(${arg(anyType(r, cx.raw))})`, () => `SUM(${arg('integer')})`, () => `${minmax}(${arg('integer')})`])(), t);
  if (t === 'decimal') return E(r.pick([() => `AVG(${arg(num(r))})`, () => `SUM(${arg('decimal')})`, () => `${minmax}(${arg('decimal')})`])(), t);
  return E(`${minmax}(${arg(t)})`, t);
}

const safe = (cx) => (cx.risky ? { ...cx, risky: false } : cx);

function caseExpr(r, cx, t, d) {
  const results = [gen(r, cx, t, d)];
  for (let k = r.int(0, 2); k > 0; k--) results.push(r.chance(0.15) ? NULL : gen(r, cx, t === 'decimal' ? num(r) : t, d));
  r.shuffle(results);
  const hasElse = r.chance(0.6);
  const whens = results.slice(0, hasElse && results.length > 1 ? -1 : results.length);
  const sc = safe(cx);
  let head = 'CASE', conds;
  if (r.chance(0.35)) {
    const vt = anyType(r, sc);
    head = `CASE ${gen(r, sc, vt, 1).s}`;
    conds = whens.map(() => (r.chance(0.15) ? NULL : vt === 'date' && r.chance(0.3) ? E(str(someDay(r)), 'text') : gen(r, sc, vt, 0)));
  } else conds = whens.map(() => gen(r, sc, 'boolean', d));
  const body = whens.map((res, i) => `WHEN ${conds[i].s} THEN ${res.s}`).join(' ');
  const tail = hasElse ? ` ELSE ${(results.length > whens.length ? results.at(-1) : gen(r, cx, t, d)).s}` : '';
  return E(`${head} ${body}${tail} END`, t);
}

function coalesce(r, cx, t, d) {
  const args = [gen(r, cx, t, d)];
  for (let k = r.int(1, 2); k > 0; k--) args.push(r.chance(0.3) ? NULL : gen(r, cx, t === 'decimal' ? num(r) : t, d));
  return call(r.pick(['COALESCE', 'coalesce', 'Coalesce']), t, ...r.shuffle(args));
}

function scalar(r, cx, t) {
  if (!cx.db || !(cx.sub > 0)) return null;
  return E(`(${subSelect(r, cx.db, t, cx.sub - 1, 'scalar')})`, t);
}

const MAKE = {
  integer: [
    (r, cx, d) => bin(gen(r, cx, 'integer', d), r.pick(['+', '-']), gen(r, cx, 'integer', d), 'integer', 5),
    (r, cx, d) => (cx.risky ? bin(gen(r, cx, 'integer', d), '*', gen(r, cx, 'integer', d), 'integer', 6) : null),
    (r, cx, d) => bin(gen(r, cx, 'integer', d), '%', r.chance(0.4) ? E(String(r.int(0, 5)), 'integer') : gen(r, cx, 'integer', d), 'integer', 6),
    (r, cx, d) => neg(gen(r, cx, 'integer', d)),
    (r, cx, d) => call('LENGTH', 'integer', gen(r, cx, 'text', d)),
    (r, cx, d) => call('INSTR', 'integer', gen(r, cx, 'text', d), literal(r, 'text')),
    (r, cx, d) => call(r.pick(['YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'year', 'Month']), 'integer', gen(r, cx, 'date', d)),
    (r, cx, d) => bin(gen(r, cx, 'date', d), '-', gen(r, cx, 'date', d), 'integer', 5),
    (r, cx, d) => call(r.pick(['FLOOR', 'CEIL']), 'integer', gen(r, cx, 'decimal', d)),
    (r, cx, d) => call('ABS', 'integer', gen(r, cx, 'integer', d)),
    (r, cx, d) => call('ROUND', 'integer', gen(r, cx, 'integer', d)),
    (r, cx, d) => cast(r, gen(r, cx, r.pick(cx.risky ? ['decimal', 'boolean', 'text'] : ['decimal', 'boolean']), d), 'integer'),
    (r, cx, d) => caseExpr(r, cx, 'integer', d),
    (r, cx, d) => coalesce(r, cx, 'integer', d),
    (r, cx) => scalar(r, cx, 'integer'),
  ],
  decimal: [
    (r, cx, d) => {
      const [a, b] = r.shuffle([gen(r, cx, 'decimal', d), gen(r, cx, num(r), d)]);
      return bin(a, r.pick(['+', '-']), b, 'decimal', 5);
    },
    (r, cx, d) => {
      if (!cx.risky) return null;
      const [a, b] = r.shuffle([gen(r, cx, 'decimal', d), gen(r, cx, num(r), d)]);
      return bin(a, '*', b, 'decimal', 6);
    },
    (r, cx, d) => bin(gen(r, cx, num(r), d), '/', cx.risky && r.chance(0.7) ? gen(r, cx, num(r), d) : E(String(r.int(0, 7)), 'integer'), 'decimal', 6),
    (r, cx, d) => neg(gen(r, cx, 'decimal', d)),
    (r, cx, d) => call('ABS', 'decimal', gen(r, cx, 'decimal', d)),
    (r, cx, d) => (r.chance(0.5) ? call('ROUND', 'decimal', gen(r, cx, 'decimal', d)) : call('ROUND', 'decimal', gen(r, cx, 'decimal', d), E(String(r.int(0, 6)), 'integer'))),
    (r, cx, d) => cast(r, gen(r, cx, cx.risky && r.chance(0.3) ? 'text' : 'integer', d), 'decimal'),
    (r, cx, d) => caseExpr(r, cx, 'decimal', d),
    (r, cx, d) => coalesce(r, cx, 'decimal', d),
    (r, cx) => scalar(r, cx, 'decimal'),
  ],
  text: [
    (r, cx, d) => bin(gen(r, cx, anyType(r, cx), d), '||', gen(r, cx, anyType(r, cx), d), 'text', 5),
    (r, cx, d) => call(r.pick(['UPPER', 'LOWER', 'TRIM', 'upper', 'Lower']), 'text', gen(r, cx, 'text', d)),
    (r, cx, d) => (r.chance(0.5) ? call('SUBSTR', 'text', gen(r, cx, 'text', d), E(String(r.int(1, 8)), 'integer'))
      : call('SUBSTR', 'text', gen(r, cx, 'text', d), E(String(r.int(1, 8)), 'integer'), E(String(r.int(0, 5)), 'integer'))),
    (r, cx, d) => call('REPLACE', 'text', gen(r, cx, 'text', d), E(str(r.pick(['a', 'p', '', ' ', 'A', 'an', ','])), 'text'), literal(r, 'text')),
    (r, cx, d) => cast(r, gen(r, cx, anyType(r, cx), d), 'text'),
    (r, cx, d) => caseExpr(r, cx, 'text', d),
    (r, cx, d) => coalesce(r, cx, 'text', d),
    (r, cx, d) => call('NULLIF', 'text', gen(r, cx, 'text', d), literal(r, 'text')),
    (r, cx) => scalar(r, cx, 'text'),
  ],
  boolean: [
    (r, cx, d) => compare(r, cx, d),
    (r, cx, d) => compare(r, cx, d),
    (r, cx, d) => E(`${wrap(gen(r, cx, anyType(r, cx), d), 5)} IS ${r.chance(0.4) ? 'NOT ' : ''}NULL`, 'boolean', 4),
    (r, cx, d) => inList(r, cx, d),
    (r, cx, d) => {
      if (!cx.db || !(cx.sub > 0)) return null;
      const t = anyType(r, cx);
      return E(`${wrap(gen(r, cx, t, d), 5)} ${r.chance(0.3) ? 'NOT ' : ''}IN (${subSelect(r, cx.db, t, cx.sub - 1, 'in')})`, 'boolean', 4);
    },
    (r, cx, d) => like(r, cx, d),
    (r, cx, d) => {
      const t = anyType(r, cx);
      // the bounds cannot fail: whether BETWEEN works out its upper bound after a false lower one is open
      const side = () => gen(r, safe(cx), t === 'integer' || t === 'decimal' ? num(r) : t, Math.min(d, 1));
      return E(`${wrap(gen(r, cx, t, d), 5)} ${r.chance(0.3) ? 'NOT ' : ''}BETWEEN ${wrap(side(), 5)} AND ${wrap(side(), 5)}`, 'boolean', 4);
    },
    (r, cx, d) => {
      const side = () => (r.chance(0.15) ? NULL : gen(r, cx, 'boolean', d));
      return r.chance(0.5) ? bin(side(), 'AND', side(), 'boolean', 2) : bin(side(), 'OR', side(), 'boolean', 1);
    },
    (r, cx, d) => E(`NOT ${wrap(r.chance(0.1) ? NULL : gen(r, cx, 'boolean', d), 4)}`, 'boolean', 3),
    (r, cx, d) => cast(r, gen(r, cx, cx.risky && r.chance(0.3) ? 'text' : 'integer', d), 'boolean'),
  ],
  date: [
    (r, cx, d) => bin(gen(r, cx, 'date', d), r.pick(['+', '-']), small(r, cx), 'date', 5),
    (r, cx, d) => bin(small(r, cx), '+', gen(r, cx, 'date', d), 'date', 5),
    (r, cx, d) => call('ADD_MONTHS', 'date', gen(r, cx, 'date', d), r.chance(0.3) ? neg(E(String(r.int(1, 30)), 'integer')) : E(String(r.int(0, 30)), 'integer')),
    (r, cx, d) => (cx.risky && r.chance(0.3) ? cast(r, gen(r, cx, 'text', d), 'date') : dateLit(r)),
    (r, cx, d) => caseExpr(r, cx, 'date', d),
    (r, cx, d) => coalesce(r, cx, 'date', d),
    (r, cx) => scalar(r, cx, 'date'),
  ],
};

const CMP = ['=', '<>', '!=', '<', '<=', '>', '>='];
function compare(r, cx, d) {
  const t = anyType(r, cx);
  const a = gen(r, cx, t, d);
  let b;
  if (r.chance(0.08)) b = NULL;
  else if (t === 'integer' || t === 'decimal') b = gen(r, cx, num(r), d);
  else if (t === 'date' && r.chance(0.3)) b = cx.risky && cx.leaves.text.length && r.chance(0.2) ? r.pick(cx.leaves.text) : E(str(someDay(r)), 'text');
  else b = gen(r, cx, t, d);
  const [x, y] = r.chance(0.2) ? [b, a] : [a, b];
  return cmp(x, r.pick(CMP), y);
}

function inList(r, cx, d) {
  const t = anyType(r, cx);
  const items = [];
  for (let k = r.int(1, 4); k > 0; k--) items.push(r.chance(0.12) ? NULL : r.chance(0.6) ? literal(r, t === 'decimal' ? num(r) : t) : gen(r, cx, t, 0));
  return E(`${wrap(gen(r, cx, t, d), 5)} ${r.chance(0.3) ? 'NOT ' : ''}IN (${items.map((e) => e.s).join(', ')})`, 'boolean', 4);
}

const PATTERNS = ['a%', '%a', '%an%', '_', '__', 'A%', '%', '', '%e_', '50%', '%|%', '%,%', 'APPLE', 'b_', '%"%', 'É%', '%\n%', '_pp%', 'B'];
function like(r, cx, d) {
  let p;
  if (r.chance(0.3)) {
    // a word with letters changed to wildcards and its case flipped here and there
    p = [...r.pick(WORDS)].map((c) => (r.chance(0.2) ? r.pick(['%', '_']) : r.chance(0.3) ? (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()) : c)).join('');
    p = E(str(p), 'text');
  } else p = r.chance(0.15) ? gen(r, cx, 'text', 0) : E(str(r.pick(PATTERNS)), 'text');
  return E(`${wrap(gen(r, cx, 'text', d), 5)} ${r.chance(0.3) ? 'NOT ' : ''}LIKE ${wrap(p, 5)}`, 'boolean', 4);
}

// --- queries -------------------------------------------------------------------------------------------------------

const ALIASES = ['a', 'b', 'c', 'x', 'y', 'z', 'p', 'q'];
const ITEM_ALIASES = ['total', 'n', 'v', 'label', 'k', 'amount', 'name', 'id', 'first_seen', 'w'];

/** Column references of a FROM list: bare when the name is unique there (mostly), else `<table or alias>.<column>`. */
function leavesOf(r, scope, bare = false) {
  const seen = {};
  for (const e of scope) for (const c of e.tb.cols) seen[c.name] = (seen[c.name] ?? 0) + 1;
  const leaves = noLeaves();
  for (const e of scope) {
    for (const c of e.tb.cols) leaves[c.type].push({ ...E(bare || (seen[c.name] === 1 && r.chance(0.7)) ? c.name : `${e.known}.${c.name}`, c.type), col: c.name });
  }
  return leaves;
}

/** A join's ON: a key pair of one type between the new table and one before it, maybe with more. */
function joinOn(r, before, add, cx) {
  const pairs = [];
  for (const e of before) {
    for (const a of e.tb.cols) {
      for (const b of add.tb.cols) {
        if (a.type !== b.type) continue;
        const key = (a.name === 'id' && b.name === `${e.tb.name.replace(/s$/, '')}_id`) || (b.name === 'id' && a.name === `${add.tb.name.replace(/s$/, '')}_id`);
        const w = key ? 6 : a.name === b.name ? 2 : 1;
        for (let i = 0; i < w; i++) pairs.push([`${e.known}.${a.name}`, `${add.known}.${b.name}`]);
      }
    }
  }
  let on = pairs.length && !r.chance(0.08) ? `${r.pick(pairs).join(r.pick([' = ', ' = ', ' < ', ' <> ']))}` : r.pick(['TRUE', 'FALSE', '1 = 1']);
  if (r.chance(0.25)) on += ` AND ${wrap(gen(r, cx, 'boolean', 1), 3)}`;
  return on;
}

/**
 * A SELECT over `db`: { sql, cols: [{ name, type }] }. Options force a part on (true) or off (false); `want` asks for
 * items of those types, `noTail` leaves ORDER BY and LIMIT out (a union's part), `sub` the subquery depth left.
 */
function query(r, db, o = {}) {
  const sub = o.sub ?? (r.chance(0.2) ? 1 : 0);
  const risky = o.risky ?? true;
  const scope = [];
  let from = '';
  if (db.tables.length && (o.from ?? r.chance(0.93))) {
    const used = new Set();
    const add = (tb, alias) => {
      const e = { tb, known: alias ?? tb.name };
      used.add(e.known);
      return e;
    };
    const aliasFor = (tb) => {
      if (!used.has(tb.name) && r.chance(0.65)) return null;
      return r.pick(ALIASES.filter((a) => !used.has(a) && !db.tables.some((t) => t.name === a)));
    };
    const as = (e) => (e.known === e.tb.name ? e.tb.name : `${e.tb.name}${r.pick([' AS ', ' ', ' as '])}${e.known}`);
    const first = r.pick(db.tables);
    scope.push(add(first, aliasFor(first)));
    from = as(scope[0]);
    const joins = o.joins ?? (r.chance(0.2) ? 1 : 0);
    for (let k = 0; k < joins; k++) {
      const tb = r.pick(db.tables);
      const e = add(tb, aliasFor(tb));
      const kind = r.pick(['JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'join', 'left join']);
      const on = joinOn(r, scope, e, { leaves: leavesOf(r, [...scope, e]), risky, db: null, sub: 0 });
      scope.push(e);
      from += ` ${kind} ${as(e)} ON ${on}`;
    }
  }
  const leaves = leavesOf(r, scope);
  const rawCx = { leaves, risky, db, sub };
  const grouped = o.group ?? r.chance(0.15);
  let groupBy = [];
  if (grouped && scope.length && (o.groupBy ?? r.chance(0.85))) {
    const all = TYPES.flatMap((t) => leaves[t]);
    for (let k = r.int(1, 2); k > 0; k--) {
      const l = r.pick(all);
      let g = l;
      if (l.t === 'date' && r.chance(0.4)) g = call(r.pick(['YEAR', 'MONTH']), 'integer', l);
      else if (l.t === 'text' && r.chance(0.3)) g = r.chance(0.5) ? call('UPPER', 'text', l) : call('LENGTH', 'integer', l);
      if (!groupBy.some((x) => x.s === g.s)) groupBy.push(g);
    }
  }
  const having = grouped && (o.having ?? r.chance(0.3));
  const gLeaves = noLeaves();
  for (const g of groupBy) gLeaves[g.t].push(g);
  const groupCx = { leaves: gLeaves, raw: { ...rawCx, sub: 0 }, risky: risky && !having, db, sub };
  const cx = grouped ? groupCx : rawCx;

  // the items, and the result's columns
  const items = [];
  const cols = [];
  const aliases = [];
  if (!o.want && !grouped && scope.length && r.chance(o.star ?? 0.2)) {
    const e = r.chance(0.6) ? null : r.pick(scope);
    items.push({ sql: e ? `${e.known}.*` : '*' });
    for (const x of e ? [e] : scope) for (const c of x.tb.cols) cols.push({ name: c.name, type: c.type });
  }
  const n = o.want ? o.want.length : items.length && r.chance(0.6) ? 0 : r.int(1, 4);
  for (let i = 0; i < n; i++) {
    const t = o.want ? o.want[i] : anyType(r, cx);
    const e = gen(r, cx, t, o.depth ?? r.int(0, 2));
    let alias = null;
    if (r.chance(o.alias ?? 0.3)) alias = r.pick(ITEM_ALIASES.filter((a) => !aliases.includes(a)));
    if (alias) aliases.push(alias);
    items.push({ sql: alias ? `${e.s}${r.pick([' AS ', ' ', ' as '])}${alias}` : e.s, expr: e.s, alias });
    cols.push({ name: alias ?? e.col ?? `col${cols.length + 1}`, type: e.t, expr: e.s });
  }
  const distinct = o.distinct ?? r.chance(0.12);
  let sql = `SELECT ${distinct ? 'DISTINCT ' : ''}${items.map((x) => x.sql).join(', ')}`;
  if (from) sql += ` FROM ${from}`;
  if (scope.length && (o.where ?? r.chance(0.45))) sql += ` WHERE ${gen(r, { ...rawCx, sub: Math.min(sub, 1) }, 'boolean', r.int(1, 3)).s}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.map((g) => g.s).join(', ')}`;
  if (having) sql += ` HAVING ${gen(r, { ...groupCx, risky }, 'boolean', r.int(1, 2)).s}`;
  if (!o.noTail) sql += tail(r, { order: o.order, limit: o.limit, cols, items, distinct, cx });
  return { sql, cols };
}

/** ORDER BY and LIMIT: positions, aliases and expressions (with DISTINCT, only what the items are). */
function tail(r, { order, limit, cols, items, distinct, cx, union = false }) {
  let sql = '';
  if (order ?? r.chance(0.45)) {
    const keys = [];
    for (let k = r.int(1, 3); k > 0; k--) {
      // a union's names: the first SELECT's, each only once and not a `col<n>` one
      const named = union ? cols.filter((c) => !/^col\d+$/.test(c.name) && cols.filter((x) => x.name === c.name).length === 1) : items.filter((x) => x.alias);
      const exprs = items.filter((x) => x.expr);
      const kind = r.pick(['position', 'name', 'expr', 'expr']);
      let key;
      if (kind === 'name' && named.length) key = r.pick(named)[union ? 'name' : 'alias'];
      else if (kind === 'expr' && !union && distinct && exprs.length) key = r.pick(exprs).expr;
      else if (kind === 'expr' && !union && !distinct) key = gen(r, cx, anyType(r, cx), r.int(0, 1)).s;
      if (!key || /^\d+$/.test(key)) key = String(r.int(1, cols.length));
      keys.push(`${key}${r.pick(['', '', ' ASC', ' DESC', ' desc'])}${r.pick(['', '', '', ' NULLS FIRST', ' NULLS LAST', ' nulls last'])}`);
    }
    sql += ` ORDER BY ${keys.join(', ')}`;
  }
  if (limit ?? r.chance(0.2)) sql += ` LIMIT ${r.pick([0, 1, 1, 2, 3, 5, 100])}${r.chance(0.4) ? ` OFFSET ${r.pick([0, 1, 2, 4, 50])}` : ''}`;
  return sql;
}

/** Two to three SELECTs joined by UNION or UNION ALL, their columns of one type (integers and decimals mixed). */
function union(r, db, o = {}) {
  const first = query(r, db, { ...o, noTail: true, want: o.want, group: o.want ? false : undefined });
  const want = first.cols.map((c) => c.type ?? 'boolean');
  let sql = first.sql;
  for (let k = r.int(1, 2); k > 0; k--) {
    const part = query(r, db, { noTail: true, sub: o.sub ?? 0, want: want.map((t) => (t === 'integer' && r.chance(0.2) ? 'decimal' : t === 'decimal' && r.chance(0.3) ? 'integer' : t)) });
    sql += ` ${r.pick(['UNION', 'UNION ALL', 'union all', 'UNION'])} ${part.sql}`;
  }
  if (!o.noTail) sql += tail(r, { order: o.order, limit: o.limit, cols: first.cols, items: [], union: true });
  return { sql, cols: first.cols };
}

/** A subquery of one column of type `t`: one row for a scalar (an aggregate, or LIMIT 1), any rows for IN. */
function subSelect(r, db, t, sub, mode) {
  const tb = r.pick(db.tables.filter((x) => x.cols.some((c) => c.type === t) || t === 'integer'));
  if (!tb) return `SELECT ${literal(r, t).s}`;
  const scope = [{ tb, known: tb.name }];
  const cx = { leaves: leavesOf(r, scope), risky: true, db, sub };
  const where = r.chance(0.4) ? ` WHERE ${gen(r, cx, 'boolean', 1).s}` : '';
  const col = cx.leaves[t].length ? r.pick(cx.leaves[t]) : null;
  if (mode === 'in' && col && r.chance(0.15)) return union(r, db, { want: [t], noTail: true, sub }).sql;
  const many = mode === 'in' ? r.chance(0.7) : r.chance(0.08);
  if (col && (many || r.chance(0.3))) {
    return `SELECT ${col.s} FROM ${tb.name}${where}${many ? '' : ` ORDER BY ${col.s}${r.pick(['', ' DESC'])} LIMIT 1`}`;
  }
  const raw = { leaves: cx.leaves, risky: true, db: null, sub: 0 };
  const agg = col ? aggregate(r, { leaves: noLeaves(), raw }, t) : t === 'integer' ? E('COUNT(*)', t) : null;
  return agg ? `SELECT ${agg.s} FROM ${tb.name}${where}` : `SELECT ${literal(r, t).s}`;
}

// --- statements that change tables -----------------------------------------------------------------------------------

/** Types that may be assigned to a column of type `t` (an integer to a decimal, a text to a date). */
const assignable = (r, t, textDate = true) => (t === 'decimal' && r.chance(0.3) ? 'integer' : t === 'date' && textDate && r.chance(0.2) ? 'text-date' : t);
const valueFor = (r, cx, t, d) => (t === 'text-date' ? E(str(someDay(r)), 'text') : gen(r, cx, t, d));

function insert(r, db, tb, o = {}) {
  const named = r.chance(0.5) ? r.some(tb.cols, 1, tb.cols.length) : null;
  const target = named ?? tb.cols;
  const head = `INSERT INTO ${tb.name}${named ? ` (${named.map((c) => c.name).join(', ')})` : ''}`;
  if (o.select ?? r.chance(0.3)) {
    const want = target.map((c) => { const t = assignable(r, c.type, false); return t; });
    return `${head} ${(r.chance(0.2) ? union : query)(r, db, { want, noTail: false }).sql}`;
  }
  const cx = { leaves: noLeaves(), risky: o.risky ?? true, db, sub: r.chance(0.15) ? 1 : 0 };
  const rows = [];
  for (let k = r.int(1, 3); k > 0; k--) {
    rows.push(`(${target.map((c) => {
      if (r.chance(0.5)) return sqlValue(r, c.type, c.kind === 'id' ? String(r.int(1, 20)) : value(r, c.kind, db)).s;
      return r.chance(0.1) ? 'NULL' : valueFor(r, cx, assignable(r, c.type), r.int(0, 2)).s;
    }).join(', ')})`);
  }
  return `${head} VALUES ${rows.join(r.pick([', ', ',\n']))}`;
}

function update(r, db, tb, o = {}) {
  const set = r.some(tb.cols, 1, 3);
  const where = o.where ?? r.chance(0.6);
  const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }], true), risky: !where, db, sub: r.chance(0.15) ? 1 : 0 };
  const parts = set.map((c) => `${c.name} = ${valueFor(r, cx, assignable(r, c.type), r.int(0, 2)).s}`);
  return `UPDATE ${tb.name} SET ${parts.join(', ')}${where ? ` WHERE ${gen(r, { ...cx, risky: true }, 'boolean', r.int(1, 2)).s}` : ''}`;
}

function remove(r, db, tb) {
  const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }], true), risky: true, db, sub: r.chance(0.15) ? 1 : 0 };
  return `DELETE FROM ${tb.name}${r.chance(0.75) ? ` WHERE ${gen(r, cx, 'boolean', r.int(1, 2)).s}` : ''}`;
}

const NEW_COLS = ['id', 'label', 'qty', 'price', 'day', 'ok', 'note', 'date', 'text', 'n'];
function newColumns(r) {
  return r.some(NEW_COLS, 1, 4).map((name) => ({ name, type: r.pick(TYPES) }));
}
const withKinds = (cols) => cols.map((c) => ({ ...c, kind: KINDS[c.type] }));
const createSql = (r, name, cols, ifNot = false) =>
  `CREATE TABLE ${ifNot ? 'IF NOT EXISTS ' : ''}${name} (${cols.map((c) => `${c.name} ${typeName(r, c.type)}`).join(', ')})`;

// --- the command line ------------------------------------------------------------------------------------------------

const FORMATS = ['table', 'csv', 'json', 'markdown'];
/** `sift query <sql>` (or another command) with `--format` before or after its argument, now and then. */
function withFormat(r, cmd, arg, p = 0.4, format = r.pick(FORMATS)) {
  if (!r.chance(p)) return [cmd, arg];
  return r.chance(0.6) ? [cmd, arg, '--format', format] : [cmd, '--format', format, arg];
}
const q = (r, sql, p = 0.4) => withFormat(r, 'query', r.chance(0.15) ? `${sql};` : sql, p);
const done = (args, files, now) => ({ args, files, now });
const tableWith = (db, pred) => db.tables.find((t) => t.cols.some(pred));
const colOf = (tb, type) => tb.cols.find((c) => c.type === type)?.name;

/** Fill `{t}`, `{u}` (two tables) and `{int}`, `{dec}`, `{text}`, `{bool}`, `{date}` (columns of `{t}`); null when one
 *  of them is missing. */
function fill(r, tpl, db) {
  const t = r.pick(db.tables);
  const u = r.pick(db.tables.filter((x) => x !== t)) ?? null;
  let missing = false;
  const s = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 't') return t?.name ?? (missing = true, '');
    if (k === 'u') return u?.name ?? (missing = true, '');
    const type = { int: 'integer', dec: 'decimal', text: 'text', bool: 'boolean', date: 'date' }[k];
    const c = t && colOf(t, type);
    return c ?? (missing = true, '');
  });
  return missing ? null : s;
}
function pickFilled(r, list, db) {
  for (let k = 0; k < 20; k++) {
    const s = fill(r, r.pick(list), db);
    if (s !== null) return s;
  }
  return 'SELECT 1';
}

/** Change the case of words and the spacing outside text literals: identifiers and keywords keep their meaning. */
function mangle(r, sql) {
  return sql.split(/('(?:[^']|'')*')/).map((s, i) => (i % 2 ? s : s
    .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => r.pick([w, w, w.toLowerCase(), w.toUpperCase(), [...w].map((c) => (r.chance(0.5) ? c.toUpperCase() : c.toLowerCase())).join('')]))
    .replace(/ /g, () => r.pick([' ', ' ', ' ', '  ', '\t', '\n', '\r\n', ' /* c */ ', ' /* a\nb */ ', ' -- note\n'])))).join('');
}

/** A random statement that cannot run: its exit code (4, 5 or 6) is what is compared. */
function failing(r, db) {
  if (!db.tables.length) return 'SELECT * FROM nothere';
  const t = r.pick(db.tables).name;
  return r.pick([
    'SELECT * FROM nothere', `INSERT INTO nothere VALUES (1)`, `SELECT nosuch FROM ${t}`, "SELECT 1 + 'a'", "SELECT CAST('x' AS INTEGER)",
    `SELECT (SELECT 1 UNION ALL SELECT 2)`, `DROP TABLE nothere`, "SELECT SUBSTR('abc', 0)", `CREATE TABLE ${t} (a integer)`,
  ]);
}

// --- the features: each stresses one part of the brief or the change and keeps the rest ------------------------------

const PRECEDENCE = [
  '1 + 2 * 3', '(1 + 2) * 3', '-2 * 3', '- 2 * -3', '10 - 4 - 3', '10 - (4 - 3)', '2 * 3 % 4', '7 % 3 * 2', '1 + 2 || 3',
  "'a' || 1 + 2", '1 || 2 * 3', 'NOT 1 = 2', 'NOT TRUE AND FALSE', 'TRUE OR FALSE AND FALSE', '(TRUE OR FALSE) AND FALSE',
  'NOT NULL IS NULL', '1 = 1 AND 2 BETWEEN 1 AND 3', '2 BETWEEN 1 AND 3 AND FALSE', '1 + 2 IN (3, 4)', '-5 % 3', '5 % -3',
  '-(1 + 2)', "'x' LIKE 'X' OR 1 = 0", '7 / 2 * 2', '1 + 2 * 3 - 4 / 2', '1 || 2 + 3', '2 * 3 / 4', '-7 / 2', '1 - -1',
  'NOT FALSE = FALSE', 'TRUE AND NOT FALSE', '3 > 2 = TRUE', '1 < 2 < 3', '0.1 + 0.2', '1 + 0.5 * 2', "'a' || 'b' = 'ab'",
];
const SYNTAX = [
  'SELECT 1 +', 'SELECT FROM {t}', 'SELECT * FROM', 'SELECT * FROM {t} WHERE', 'SELECT * FROM {t}, {u}', 'SELECT 1 = 1 = 1',
  "SELECT 'abc", 'SELECT /* never closed', 'SELECT 1; SELECT 2', 'SELECT .5', 'SELECT 5.', 'SELECT 1.1234567',
  'SELECT 9223372036854775808', 'SELECT 1234567890123456789.5', 'SELECT 1 # 2', 'SELECT @x', 'SELECT "{int}" FROM {t}', 'SELECT [x]',
  'SELECT * FROM {t} LIMIT 1.5', 'SELECT * FROM {t} LIMIT -1', 'SELECT * FROM {t} OFFSET 1', 'SELECT * FROM {t} LIMIT 1 OFFSET',
  'SELECT * FROM {t} ORDER BY {int} WHERE TRUE', 'SELECT * FROM {t} GROUP BY {int} WHERE TRUE', 'SELECT {int} FROM {t} HAVING',
  'SELECT 1 IN ()', 'SELECT COUNT(DISTINCT {int}) FROM {t}', 'SELECT select FROM {t}', 'SELECT 1 AS from', 'SELECT * FROM select',
  'SELECT (1', 'SELECT 1)', 'SELECT CAST(1 AS)', 'SELECT CAST(1 INTEGER)', 'SELECT CASE WHEN TRUE THEN 1', 'SELECT CASE END',
  'SELECT 1 UNION ORDER BY 1', 'SELECT 1 ORDER BY 1 UNION SELECT 2', 'SELECT 1 LIMIT 1 UNION ALL SELECT 2',
  'INSERT INTO {t} VALUES ()', 'INSERT {t} VALUES (1)', 'UPDATE {t} SET', 'UPDATE {t} {int} = 1', 'DELETE {t}', 'CREATE TABLE tmp ()',
  'CREATE TABLE tmp (a)', 'DROP {t}', 'DROP TABLE', 'SELECT 1;;', 'SELECT 1 1', 'SELECT a.b.c FROM {t}', 'SELECT 1 NOT 2',
  'SELECT * FROM {t} JOIN {u}', 'SELECT * FROM {t} LEFT {u} ON TRUE', "SELECT 'a' ||", 'SELECT -', 'SELECT 1 * * 2',
  'SELECT *, FROM {t}', 'SELECT 1,', 'SELECT 1 AS', 'SELECT ALL 1', 'SELECT 1 FROM {t} WHERE EXISTS (SELECT 1)', 'SELECT IF',
  'CREATE TABLE IF EXISTS tmp (a integer)', 'DROP TABLE IF NOT EXISTS {t}', 'SELECT 1 /* x */ */', 'SELECT 1 FROM {t} AS',
  'SELECT * FROM {t} x y', 'SELECT * FROM {t} ORDER BY', 'SELECT * FROM {t} ORDER BY {int} NULLS', 'SELECT {int} FROM {t} GROUP {int}',
  'SELECT 1 + 2 3', 'SELECT * FROM {t} WHERE {int} = = 1', 'SELECT * FROM {t} WHERE {int} NOT NULL', 'SELECT * FROM {t} WHERE {int} BETWEEN 1',
  'SELECT * FROM {t} WHERE {int} IS 1', 'SELECT TRUE IS TRUE', 'SELECT 1 <> 2 AND', 'SELECT 1 FROM {t} ;x', 'SELECT 1 FROM {t} WHERE {int} IN 1',
  "SELECT 'it's'", 'SELECT 1 UNION', 'SELECT 1 UNION ALL ALL SELECT 2', 'SELECT * FROM {t} INNER LEFT JOIN {u} ON TRUE', 'SELECT 1 !',
  'SELECT 1 ! = 2', 'SELECT 1 = > 2', 'SELECT x(', "SELECT '\n\nabc", 'SELECT 1\n/* a\n\nb', 'SELECT 1\n\n  +',
];
const TYPE_ERRORS = [
  "SELECT 1 + 'a'", "SELECT 'a' + 1", 'SELECT TRUE + 1', 'SELECT -TRUE', "SELECT -'a'", 'SELECT NOT 1', 'SELECT 1 AND TRUE', 'SELECT 1 % 1.5',
  'SELECT 1.5 % 2', 'SELECT 7 / 2 % 2', "SELECT 1 LIKE 'a'", "SELECT 'a' LIKE 1", "SELECT 1 = 'a'", 'SELECT TRUE < 1', "SELECT TRUE = 'true'",
  'SELECT UPPER(1)', 'SELECT LENGTH(TRUE)', "SELECT ABS('x')", 'SELECT ROUND(1.5, 1.0)', "SELECT SUBSTR('abc', 1.0)", 'SELECT ADD_MONTHS(TODAY(), 1.5)',
  "SELECT YEAR('2024-01-01')", 'SELECT YEAR(1)', 'SELECT TODAY() + 1.5', 'SELECT TODAY() + TODAY()', 'SELECT TODAY() * 2', 'SELECT 1 - TODAY()',
  'SELECT CAST(TODAY() AS INTEGER)', 'SELECT CAST(TRUE AS DECIMAL)', 'SELECT CAST(1.5 AS BOOLEAN)', 'SELECT CAST(1 AS DATE)', 'SELECT CAST(TODAY() AS DECIMAL)',
  'SELECT CAST(TRUE AS DATE)', "SELECT COALESCE(1, 'a')", "SELECT CASE WHEN TRUE THEN 1 ELSE 'a' END", 'SELECT CASE WHEN 1 THEN 2 END',
  "SELECT CASE 1 WHEN 'a' THEN 2 END", "SELECT NULLIF(1, 'a')", "SELECT 1 IN (1, 'a')", "SELECT 1 BETWEEN 'a' AND 2", 'SELECT * FROM {t} WHERE {int}',
  'SELECT * FROM {t} WHERE {text}', 'SELECT * FROM {t} JOIN {u} ON 1', 'SELECT {int} FROM {t} GROUP BY {int} HAVING COUNT(*)', 'SELECT FLOOR(TRUE)',
  "SELECT INSTR(1, 'a')", "SELECT REPLACE('a', 1, 'b')", 'SELECT WEEKDAY(1.5)', 'SELECT CASE WHEN TRUE THEN TODAY() ELSE 1 END',
  "SELECT CASE WHEN TRUE THEN 7 / 2 ELSE 'x' END", "INSERT INTO {t} ({int}) VALUES ('5')", 'INSERT INTO {t} ({int}) VALUES (1.5)',
  'INSERT INTO {t} ({int}) VALUES (7 / 2)', 'INSERT INTO {t} ({text}) VALUES (5)', 'INSERT INTO {t} ({bool}) VALUES (1)', 'INSERT INTO {t} ({date}) VALUES (20240101)',
  'UPDATE {t} SET {int} = {text}', 'INSERT INTO {t} ({int}) SELECT {text} FROM {t}', 'SELECT 1 || 2 + 3', 'SELECT {date} + {dec} FROM {t}',
  'SELECT {text} || 1 - 1 FROM {t}', 'SELECT SUM({text}) FROM {t}', 'SELECT AVG({date}) FROM {t}', 'SELECT {bool} > 0 FROM {t}',
  'SELECT {int} FROM {t} WHERE {int} LIKE \'1%\'', 'SELECT * FROM {t} WHERE NOT {date}', 'SELECT 1 UNION SELECT \'a\'', 'SELECT 1 UNION SELECT TODAY()',
  'UPDATE {t} SET {bool} = 0', 'UPDATE {t} SET {dec} = TRUE', 'SELECT {int} FROM {t} WHERE {int} IN (SELECT {text} FROM {t})',
];
const NAME_ERRORS = [
  'SELECT nosuch FROM {t}', 'SELECT {t}.nosuch FROM {t}', 'SELECT zz.{int} FROM {t}', 'SELECT zz.* FROM {t}', 'SELECT * FROM {t} JOIN {t} ON TRUE',
  'SELECT * FROM {t} a JOIN {u} a ON TRUE', 'SELECT * FROM {t} a JOIN {t} b ON a.{int} = c.{int}', 'SELECT * FROM {t} JOIN {u} ON {u}.{int} = zz.x',
  'SELECT {int} FROM {t} WHERE {int} IN (SELECT 1 FROM {u} WHERE {t}.{int} = 1)', 'SELECT {int} AS q FROM {t} WHERE q > 1',
  'SELECT {int} AS q FROM {t} GROUP BY q', 'SELECT 1 AS a, 2 AS a ORDER BY a', 'SELECT {int} FROM {t} ORDER BY 0', 'SELECT {int} FROM {t} ORDER BY 2',
  'SELECT *', 'SELECT * FROM nothere', 'SELECT * FROM {t} JOIN nothere ON TRUE', 'INSERT INTO nothere VALUES (1)', 'UPDATE nothere SET a = 1',
  'DELETE FROM nothere', 'DROP TABLE nothere', 'CREATE TABLE {t} (a integer)', 'INSERT INTO {t} (nosuch) VALUES (1)', 'INSERT INTO {t} ({int}, {int}) VALUES (1, 2)',
  'INSERT INTO {t} ({int}) VALUES (1, 2)', 'INSERT INTO {t} ({int}) VALUES ({int})', 'INSERT INTO {t} ({int}) SELECT 1, 2', 'UPDATE {t} SET nosuch = 1',
  'UPDATE {t} SET {int} = 1, {int} = 2', 'CREATE TABLE tmp (a integer, A text)', 'SELECT (SELECT {int}, {int} FROM {t})', 'SELECT 1 IN (SELECT {int}, {int} FROM {t})',
  'SELECT 1, 2 UNION SELECT 3', 'SELECT {int} FROM {t} UNION SELECT {int} FROM {t} ORDER BY {int} + 1', 'SELECT {int} FROM {t} UNION SELECT 1 ORDER BY nosuch',
  'SELECT nosuch()', 'SELECT LENGTH()', 'SELECT COALESCE(1)', 'SELECT TODAY(1)', "SELECT SUBSTR('a')", 'SELECT ROUND(1.5, 1, 2)', 'SELECT ABS(1, 2)',
  'SELECT DISTINCT {int} FROM {t} ORDER BY nosuch', 'SELECT DISTINCT {text} FROM {t} ORDER BY {int}', 'SELECT * FROM {t} WHERE nosuch IS NULL',
  'SELECT * FROM {t} x JOIN {u} ON {t}.{int} = 1', 'SELECT {t}.* FROM {t} x', 'INSERT INTO {t} VALUES (1, 2, 3, 4, 5, 6, 7, 8)', 'SELECT * FROM {t} ORDER BY nosuch',
  'SELECT * FROM nothere WHERE nosuch = 1', 'SELECT * FROM {t} JOIN nothere ON nothere.a = {t}.nosuch',
];
const AGG_ERRORS = [
  'SELECT COUNT(*) FROM {t} WHERE COUNT(*) > 1', 'SELECT {int}, COUNT(*) FROM {t}', 'SELECT SUM(MAX({int})) FROM {t}', 'SELECT COUNT(*) FROM {t} GROUP BY COUNT(*)',
  'SELECT {int} FROM {t} GROUP BY {text}', 'SELECT {text} FROM {t} GROUP BY {text} ORDER BY {int}', 'SELECT {text} FROM {t} GROUP BY {text} HAVING {int} > 1',
  'SELECT * FROM {t} JOIN {u} ON COUNT(*) > 0', 'UPDATE {t} SET {int} = SUM({int})', 'DELETE FROM {t} WHERE MAX({int}) > 1', 'INSERT INTO {t} ({int}) VALUES (COUNT(*))',
  'SELECT DISTINCT {text} FROM {t} GROUP BY {text} ORDER BY MAX({int})', 'SELECT COUNT({int}, {int}) FROM {t}', 'SELECT COUNT() FROM {t}', 'SELECT * FROM {t} GROUP BY {int}',
  'SELECT {int} + 1 FROM {t} GROUP BY {int} + 2', 'SELECT {int} FROM {t} HAVING COUNT(*) > 0', 'SELECT {int} FROM {t} ORDER BY SUM({int})',
  'SELECT MAX({int}) FROM {t} GROUP BY {text} HAVING {text} = MIN({int})', 'SELECT AVG({text}) FROM {t}', 'SELECT SUM({bool}) FROM {t}',
  // and ones that are fine
  'SELECT {text}, COUNT(*) FROM {t} GROUP BY {text}', 'SELECT COUNT(*) FROM {t} WHERE FALSE', 'SELECT MAX({int}) FROM {t} HAVING COUNT(*) > 100',
  'SELECT {int} + 1 FROM {t} GROUP BY {int}', 'SELECT COUNT(NULL), COUNT(*), SUM({int}) FROM {t} WHERE FALSE', 'SELECT {text} FROM {t} GROUP BY {text} ORDER BY COUNT(*) DESC',
  'SELECT DISTINCT {text}, COUNT(*) FROM {t} GROUP BY {text} ORDER BY COUNT(*)', 'SELECT MIN({text}), MAX({date}), MIN({bool}) FROM {t}',
];
const TEXT_FUNCS = [
  "LENGTH('')", "LENGTH('é')", "LENGTH('😀')", "UPPER('straße é')", "LOWER('ÀBC é')", "TRIM('  a b  ')", "TRIM('\ta\t')", "TRIM('   ')",
  "SUBSTR('hello', 2)", "SUBSTR('hello', 2, 3)", "SUBSTR('hello', 6)", "SUBSTR('hello', 9, 2)", "SUBSTR('hello', 1, 0)", "SUBSTR('hello', 5, 100)",
  "SUBSTR('hello', 0)", "SUBSTR('hello', 1, -1)", "REPLACE('aaa', 'aa', 'b')", "REPLACE('abc', '', 'x')", "REPLACE('abc', 'B', 'x')", "REPLACE('a.b.c', '.', '')",
  "INSTR('hello', 'l')", "INSTR('hello', '')", "INSTR('hello', 'z')", "INSTR('', '')", "INSTR('Hello', 'h')", "'a' || NULL", "'x' || 1.50",
  "'x' || TRUE", "'d' || CAST('2024-01-05' AS DATE)", "1 || 2", "UPPER(CAST(NULL AS TEXT))", "SUBSTR(CAST(NULL AS TEXT), 2)", "SUBSTR('abc', CAST(NULL AS INTEGER))",
  "LENGTH('two\nlines')", "REPLACE('banana', 'ana', 'X')", "UPPER('mIxEd 123')", "'' || ''", "CAST(-0.5 AS TEXT) || '|'",
];
const NUMBER_FUNCS = [
  'ROUND(2.5)', 'ROUND(-2.5)', 'ROUND(-2.45, 1)', 'ROUND(2.675, 2)', 'ROUND(1.000005, 5)', 'ROUND(5)', 'ROUND(5, 2)', 'ROUND(1.5, 7)', 'ROUND(1.5, -1)',
  'ROUND(0.4)', 'ROUND(-0.4)', 'ROUND(123.456789, 6)', 'FLOOR(-2.5)', 'CEIL(-2.5)', 'FLOOR(2.0)', 'CEIL(0.000001)', 'FLOOR(7)', 'CEIL(-7)', 'ABS(-3)', 'ABS(-2.5)',
  'ABS(0.0)', 'ABS(-9223372036854775807 - 1)', 'ABS(-9223372036854775807)', 'ROUND(CAST(NULL AS DECIMAL), 1)', 'FLOOR(-0.000001)', 'CEIL(-0.999999)',
  'ROUND(-0.000001, 2)', 'ROUND(999.999995, 5)', 'ROUND(0.5, 0)', 'ABS(CAST(NULL AS INTEGER))', 'ROUND(2.5, CAST(NULL AS INTEGER))',
];
const DATE_FUNCS = [
  "ADD_MONTHS(CAST('2024-01-31' AS DATE), 1)", "ADD_MONTHS(CAST('2023-01-31' AS DATE), 1)", "ADD_MONTHS(CAST('2024-03-31' AS DATE), -1)",
  "ADD_MONTHS(CAST('2024-02-29' AS DATE), 12)", "ADD_MONTHS(CAST('2024-02-29' AS DATE), -12)", "ADD_MONTHS(CAST('2024-05-15' AS DATE), -17)",
  'WEEKDAY(TODAY())', "WEEKDAY(CAST('2024-01-01' AS DATE))", "WEEKDAY(CAST('2023-12-31' AS DATE))", 'YEAR(TODAY())', "TODAY() - CAST('2024-01-01' AS DATE)",
  "CAST('2024-03-01' AS DATE) - CAST('2024-02-01' AS DATE)", "CAST('2024-03-01' AS DATE) - 1", "1 + CAST('2024-02-28' AS DATE)", "CAST('2023-12-31' AS DATE) + 1",
  "CAST('2024-01-05' AS DATE) = '2024-01-05'", "CAST('2024-01-05' AS DATE) < '2024-1-6'", "'2024-01-05' > CAST('2023-12-31' AS DATE)",
  'MONTH(CAST(NULL AS DATE))', "DAY(CAST('2024-02-29' AS DATE))", "ADD_MONTHS(TODAY(), 0)", "TODAY() + 366", "TODAY() - TODAY()",
  "CAST('2000-03-01' AS DATE) - CAST('1900-03-01' AS DATE)", "WEEKDAY(CAST('1900-01-01' AS DATE))", "ADD_MONTHS(CAST('2024-01-31' AS DATE), CAST(NULL AS INTEGER))",
  "CAST('2024-01-05' AS DATE) IN (CAST('2024-01-05' AS DATE), NULL)", "CAST('2024-01-05' AS DATE) BETWEEN '2024-01-01' AND '2024-12-31'",
];
const CASTS = [
  "'007'", "'-0'", "' 5'", "'5 '", "'1.5'", "'1.1234567'", "'+5'", "'true'", "'TRUE'", "'false'", "'2024-02-29'", "'2023-02-29'", "''", "'abc'",
  "'9223372036854775807'", "'9223372036854775808'", "'-9223372036854775808'", "'12.000000'", "'.5'", "'5.'", "'1e3'", "'0001-01-01'", "'2024-1-5'",
  '0', '1', '-1', '42', '2.7', '-2.7', '0.000001', 'TRUE', 'FALSE', "CAST('2024-03-15' AS DATE)", 'NULL', '1.0', '7 / 2', '-0.0',
];

const BUILD = {
  plain: (r) => {
    const db = makeDb(r);
    return done(q(r, query(r, db).sql, 0.3), files(r, db), today(r));
  },
  expressions: (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.5)) {
      const items = r.some(PRECEDENCE, 1, 3);
      return done(q(r, `SELECT ${items.join(', ')}`), files(r, db), today(r));
    }
    return done(q(r, query(r, db, { depth: 3, where: true }).sql), files(r, db), today(r));
  },
  division: (r) => {
    const db = makeDb(r, 1, 2);
    const scope = r.pick(db.tables);
    const cx = { leaves: leavesOf(r, [{ tb: scope, known: scope.name }]), risky: true, db: null, sub: 0 };
    const items = [];
    for (let k = r.int(1, 4); k > 0; k--) {
      const side = (t) => (r.chance(0.5) ? gen(r, cx, t, 0) : r.chance(0.3) ? E(r.pick(['0', '0.0', '1', '3', '-2']), 'integer') : neg(literal(r, t)));
      const op = r.chance(0.7) ? '/' : '%';
      const t = op === '%' ? 'integer' : num(r);
      const e = bin(side(t), op, side(op === '%' ? 'integer' : num(r)), op === '/' ? 'decimal' : 'integer', 6);
      items.push(r.pick([e.s, e.s, `CAST(${e.s} AS INTEGER)`, `SUM(${e.s})`, `COALESCE(${e.s}, -1)`]));
    }
    // aggregates and plain items do not mix: either all aggregates or none
    const agg = items.some((s) => s.startsWith('SUM('));
    const list = agg ? items.map((s) => (s.startsWith('SUM(') ? s : `COUNT(${s})`)) : items;
    const sql = r.chance(0.3) ? `SELECT ${r.pick(['7 / 2', '-7 / 2', '6 / 3', '1 / 3', '2 / 3', '-2 / 3', '1 / 0', '1.5 / 0.0', '7 % 0', '-7 % 3', '7 % -3', '0 / 5', '1.0 / 3'])}`
      : `SELECT ${list.join(', ')} FROM ${scope.name}`;
    return done(q(r, sql), files(r, db), today(r));
  },
  decimals: (r) => {
    const db = makeDb(r, 1, 2);
    const lit = () => (r.chance(0.3) ? neg(E(someDecimal(r, 0), 'decimal')) : E(someDecimal(r, 0), 'decimal'));
    const items = [];
    for (let k = r.int(1, 4); k > 0; k--) {
      const op = r.pick(['+', '-', '*', '/', '*', '/']);
      items.push(bin(lit(), op, r.chance(0.3) ? E(String(r.int(1, 9)), 'integer') : lit(), 'decimal', op === '+' || op === '-' ? 5 : 6).s);
    }
    if (r.chance(0.3)) items.push(r.pick(['0.000005 * 0.1', '-0.000005 * 0.1', '0.0 - 0.0', '-0.0', '0.1 * 0.1', '1.0 / 3', '2.0 / 3', '0.000001 / 2', '-0.000001 / 2']));
    if (r.chance(0.4)) {
      const tb = tableWith(db, (c) => c.type === 'decimal');
      if (tb) {
        const c = colOf(tb, 'decimal');
        return done(q(r, r.pick([`SELECT ${c}, ${c} * 3, ${c} / 7, -${c} FROM ${tb.name}`, `SELECT SUM(${c}), AVG(${c}), MIN(${c}), MAX(${c}) FROM ${tb.name}`,
          `SELECT ${c} FROM ${tb.name} ORDER BY ${c}`, `SELECT ${c} + 0.000001, ROUND(${c}, 1), CAST(${c} AS INTEGER) FROM ${tb.name}`])), files(r, db, { loose: looseAll(r, db) }), today(r));
      }
    }
    return done(q(r, `SELECT ${items.join(', ')}`), files(r, db), today(r));
  },
  casts: (r) => {
    const db = makeDb(r, 1, 2);
    const items = [];
    for (let k = r.int(1, 3); k > 0; k--) items.push(`CAST(${r.pick(CASTS)} AS ${typeName(r, r.pick(TYPES))})`);
    if (r.chance(0.4)) {
      const tb = r.pick(db.tables);
      const c = r.pick(tb.cols);
      return done(q(r, `SELECT ${c.name}, CAST(${c.name} AS ${typeName(r, r.pick(TYPES))}) FROM ${tb.name}`), files(r, db), today(r));
    }
    return done(q(r, `SELECT ${items.join(', ')}`), files(r, db), today(r));
  },
  coercion: (r) => {
    const db = makeDb(r, 1, 3);
    const tb = r.pick(db.tables);
    const sqls = [
      'SELECT 1 = 1.0, 2 > 1.5, 1 IN (1.0, 2), 0.5 BETWEEN 0 AND 1', 'SELECT CASE WHEN TRUE THEN 1 ELSE 2.5 END, COALESCE(NULL, 1, 0.5)',
      "SELECT CAST('2024-01-05' AS DATE) = '2024-01-05', '2024-01-05' < CAST('2024-01-06' AS DATE)", "SELECT CAST('2024-01-05' AS DATE) = 'soon'",
    ];
    const dateCol = colOf(tb, 'date'), decCol = colOf(tb, 'decimal'), intCol = colOf(tb, 'integer'), textCol = colOf(tb, 'text');
    if (dateCol) {
      sqls.push(`SELECT * FROM ${tb.name} WHERE ${dateCol} >= '${someDay(r)}'`, `SELECT ${dateCol} FROM ${tb.name} WHERE ${dateCol} = '${someDay(r)}' OR ${dateCol} IS NULL`,
        `INSERT INTO ${tb.name} (${dateCol}) VALUES ('${r.pick([someDay(r), '2023-02-29', '2024-1-5', 'x'])}')`);
      if (textCol) sqls.push(`SELECT ${dateCol} = ${textCol} FROM ${tb.name}`);
    }
    if (decCol) sqls.push(`SELECT * FROM ${tb.name} WHERE ${decCol} > ${r.int(0, 50)}`, `INSERT INTO ${tb.name} (${decCol}) VALUES (${r.int(0, 99)}), (${someDecimal(r)})`,
      `SELECT ${decCol} + 1, ${decCol} = 2 FROM ${tb.name}`);
    if (intCol) sqls.push(`SELECT ${intCol} = ${someDecimal(r, 0)}, ${intCol} * 1.5 FROM ${tb.name}`, `SELECT * FROM ${tb.name} WHERE ${intCol} IN (1.0, 2.5, 3)`);
    return done(q(r, r.pick(sqls)), files(r, db, { loose: looseAll(r, db, 0.3) }), today(r));
  },
  'three-valued': (r) => {
    const db = makeDb(r, 1, 2);
    const bools = ['NULL AND FALSE', 'NULL AND TRUE', 'NULL OR TRUE', 'NULL OR FALSE', 'NOT NULL', 'NULL IS NULL', 'NULL IS NOT NULL', '1 IN (1, NULL)',
      '1 IN (2, NULL)', '1 NOT IN (2, NULL)', '1 NOT IN (1, NULL)', '5 BETWEEN NULL AND 3', '5 BETWEEN NULL AND 7', 'NULL = NULL', 'NULL <> 1',
      'CAST(NULL AS INTEGER) IN (1, 2)', "NULL LIKE 'a'", 'NOT (NULL AND FALSE)', 'FALSE AND NULL', 'TRUE OR NULL'];
    if (r.chance(0.4)) return done(q(r, `SELECT ${r.some(bools, 1, 4).join(', ')}`, 0.5), files(r, db), today(r));
    const tb = r.pick(db.tables);
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db, sub: 0 };
    const cond = () => {
      const side = () => (r.chance(0.3) ? NULL : gen(r, cx, 'boolean', 1));
      return r.pick([() => bin(side(), r.pick(['AND', 'OR']), side(), 'boolean', 2), () => inList(r, cx, 0), () => E(`NOT ${wrap(side(), 4)}`, 'boolean', 3)])();
    };
    return done(q(r, r.chance(0.5) ? `SELECT * FROM ${tb.name} WHERE ${cond().s}` : `SELECT ${cond().s}, ${cond().s} FROM ${tb.name}`, 0.5), files(r, db), today(r));
  },
  like: (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.3)) {
      const pairs = ["'Apple' LIKE 'a%'", "'APPLE' LIKE '%pp%'", "'apple' LIKE 'A_P%'", "'é' LIKE 'É'", "'abc' LIKE 'ab'", "'abc' NOT LIKE 'ABC'",
        "'a%b' LIKE 'a%'", "'' LIKE '%'", "'' LIKE '_'", "'x\ny' LIKE 'x_y'", "'Zoë' LIKE 'zo_'", "'50%' LIKE '50_'", "CAST(NULL AS TEXT) LIKE '%'"];
      return done(q(r, `SELECT ${r.some(pairs, 1, 4).join(', ')}`), files(r, db), today(r));
    }
    const tb = tableWith(db, (c) => c.type === 'text') ?? db.tables[0];
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db, sub: 0 };
    const e = like(r, cx, 0);
    return done(q(r, r.chance(0.5) ? `SELECT * FROM ${tb.name} WHERE ${e.s}` : `SELECT ${e.s} FROM ${tb.name}`), files(r, db), today(r));
  },
  distinct: (r) => {
    const db = makeDb(r, 1, 2);
    return done(q(r, query(r, db, { distinct: true, group: r.chance(0.2), star: 0.3 }).sql), files(r, db), today(r));
  },
  where: (r) => {
    const db = makeDb(r, 1, 3);
    return done(q(r, query(r, db, { from: true, where: true, sub: r.chance(0.3) ? 1 : 0 }).sql), files(r, db, { loose: looseAll(r, db, 0.2) }), today(r));
  },
  'order-by': (r) => {
    const db = makeDb(r, 1, 2);
    return done(q(r, query(r, db, { from: true, order: true, alias: 0.5, star: 0.3 }).sql), files(r, db), today(r));
  },
  limit: (r) => {
    const db = makeDb(r, 1, 2);
    return done(q(r, query(r, db, { from: true, limit: true }).sql), files(r, db), today(r));
  },
  aggregates: (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.3)) for (const t of db.tables) if (r.chance(0.5)) t.rows = [];
    return done(q(r, query(r, db, { from: true, group: true, groupBy: false }).sql), files(r, db), today(r));
  },
  grouping: (r) => {
    const db = makeDb(r, 1, 2);
    return done(q(r, query(r, db, { from: true, group: true, groupBy: true }).sql), files(r, db), today(r));
  },
  joins: (r) => {
    const db = makeDb(r, 2, 3);
    if (r.chance(0.2)) {
      const tb = r.pick(db.tables);
      const t = r.pick(tb.cols).name;
      return done(q(r, `SELECT * FROM ${tb.name} a ${r.pick(['JOIN', 'LEFT JOIN'])} ${tb.name} b ON a.${t} = b.${t}${r.chance(0.5) ? ` ORDER BY 1` : ''}`), files(r, db), today(r));
    }
    return done(q(r, query(r, db, { from: true, joins: r.int(1, 2), star: 0.4 }).sql), files(r, db, { loose: looseAll(r, db, 0.2) }), today(r));
  },
  subqueries: (r) => {
    const db = makeDb(r, 1, 3);
    let sql = '';
    for (let k = 0; k < 8 && !/\(SELECT /.test(sql); k++) sql = query(r, db, { sub: 2, where: r.chance(0.6) }).sql;
    if (!/\(SELECT /.test(sql)) sql = `SELECT (${subSelect(r, db, r.pick(TYPES), 1, 'scalar')})`;
    return done(q(r, sql), files(r, db), today(r));
  },
  'text-functions': (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.5)) return done(q(r, `SELECT ${r.some(TEXT_FUNCS, 1, 3).join(', ')}`), files(r, db), today(r));
    const tb = tableWith(db, (c) => c.type === 'text') ?? db.tables[0];
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db: null, sub: 0 };
    const items = [];
    for (let k = r.int(1, 3); k > 0; k--) items.push(r.pick(MAKE.text.slice(0, 5))(r, cx, 1).s);
    return done(q(r, `SELECT ${items.join(', ')} FROM ${tb.name}`), files(r, db), today(r));
  },
  'number-functions': (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.5)) return done(q(r, `SELECT ${r.some(NUMBER_FUNCS, 1, 3).join(', ')}`), files(r, db), today(r));
    const tb = r.pick(db.tables);
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db: null, sub: 0 };
    const items = [];
    for (let k = r.int(1, 3); k > 0; k--) items.push(r.pick([MAKE.integer[8], MAKE.integer[9], MAKE.integer[10], MAKE.decimal[4], MAKE.decimal[5]])(r, cx, 1).s);
    return done(q(r, `SELECT ${items.join(', ')} FROM ${tb.name}`), files(r, db), today(r));
  },
  'date-functions': (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.5)) return done(q(r, `SELECT ${r.some(DATE_FUNCS, 1, 3).join(', ')}`), files(r, db), today(r));
    const tb = tableWith(db, (c) => c.type === 'date') ?? db.tables[0];
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db: null, sub: 0 };
    const items = [];
    for (let k = r.int(1, 3); k > 0; k--) items.push(r.pick([...MAKE.date.slice(0, 3), MAKE.integer[6], MAKE.integer[7]])(r, cx, 1).s);
    return done(q(r, `SELECT ${items.join(', ')} FROM ${tb.name}`), files(r, db), today(r));
  },
  case: (r) => {
    const db = makeDb(r, 1, 2);
    const tb = r.pick(db.tables);
    const cx = { leaves: leavesOf(r, [{ tb, known: tb.name }]), risky: true, db, sub: 0 };
    const items = [];
    for (let k = r.int(1, 3); k > 0; k--) {
      const t = anyType(r, cx);
      items.push(r.pick([caseExpr, caseExpr, coalesce, (rr, c, tt, d) => call('NULLIF', tt, gen(rr, c, tt, d), gen(rr, c, tt, 0))])(r, cx, t, r.int(0, 2)).s);
    }
    return done(q(r, `SELECT ${items.join(', ')} FROM ${tb.name}`), files(r, db), today(r));
  },
  union: (r) => {
    const db = makeDb(r, 1, 3);
    const u = union(r, db, { sub: 0 });
    const sql = r.pick([
      () => u.sql,
      () => { const v = union(r, db, { want: ['integer'], noTail: true }); return `SELECT ${r.pick(['1', '2', '5'])} IN (${v.sql}), (SELECT COUNT(*) FROM ${db.tables[0].name})`; },
      () => `SELECT (${union(r, db, { want: [r.pick(TYPES)], noTail: true }).sql})`,
    ])();
    return done(q(r, sql), files(r, db), today(r));
  },
  insert: (r) => {
    const db = makeDb(r, 1, 3);
    const tb = r.pick(db.tables);
    return done(q(r, insert(r, db, tb), 0.2), files(r, db, { loose: looseAll(r, db) }), today(r));
  },
  update: (r) => {
    const db = makeDb(r, 1, 2);
    const tb = r.pick(db.tables);
    const where = r.chance(0.15) ? ' WHERE FALSE' : null;
    const sql = where ? `UPDATE ${tb.name} SET ${tb.cols[0].name} = ${tb.cols[0].name}${where}` : update(r, db, tb);
    return done(q(r, sql, 0.2), files(r, db, { loose: where ? looseAll(r, db) : [] }), today(r));
  },
  delete: (r) => {
    const db = makeDb(r, 1, 2);
    return done(q(r, remove(r, db, r.pick(db.tables)), 0.2), files(r, db, { loose: looseAll(r, db) }), today(r));
  },
  'create-drop': (r) => {
    const db = makeDb(r, 1, 3);
    const tb = r.pick(db.tables);
    const fresh = r.pick(NEW_NAMES);
    const sql = r.pick([
      () => createSql(r, fresh, newColumns(r), r.chance(0.3)), () => createSql(r, fresh, newColumns(r)), () => createSql(r, tb.name, newColumns(r), r.chance(0.6)),
      () => createSql(r, r.pick([fresh, tb.name]), [{ name: 'a', type: 'integer' }, { name: r.pick(['a', 'A']), type: 'text' }], r.chance(0.5)),
      () => `DROP TABLE ${r.chance(0.4) ? 'IF EXISTS ' : ''}${tb.name}`, () => `DROP TABLE ${r.chance(0.6) ? 'IF EXISTS ' : ''}${fresh}`,
      () => `CREATE TABLE ${fresh} (${r.pick(['date date', 'text text, integer integer', 'first boolean, last decimal', 'year integer, count integer'])})`,
    ])();
    return done(q(r, sql, 0.2), files(r, db, { loose: looseAll(r, db) }), today(r));
  },
  scripts: (r) => {
    const db = makeDb(r, 1, 3);
    const start = { tables: db.tables.slice() };
    const state = { tables: db.tables.map((t) => ({ ...t, rows: t.rows })) };
    const stmts = [];
    for (let k = r.int(1, 5); k > 0; k--) {
      const kind = r.pick(['select', 'select', 'insert', 'update', 'delete', 'create', 'drop', 'create-if', 'drop-if']);
      if (!state.tables.length && kind !== 'create' && kind !== 'create-if') {
        const cols = withKinds(newColumns(r));
        stmts.push(createSql(r, 'tmp', cols));
        state.tables.push({ name: 'tmp', cols, rows: [] });
        continue;
      }
      const tb = r.pick(state.tables);
      if (kind === 'select') stmts.push(query(r, state).sql);
      else if (kind === 'insert') stmts.push(insert(r, state, tb));
      else if (kind === 'update') stmts.push(update(r, state, tb));
      else if (kind === 'delete') stmts.push(remove(r, state, tb));
      else if (kind === 'drop' || kind === 'drop-if') {
        stmts.push(`DROP TABLE ${kind === 'drop-if' ? 'IF EXISTS ' : ''}${tb.name}`);
        state.tables = state.tables.filter((t) => t !== tb);
      } else {
        const name = r.pick(tb ? [...NEW_NAMES, tb.name] : NEW_NAMES);
        const exists = state.tables.some((t) => t.name === name);
        const cols = withKinds(newColumns(r));
        stmts.push(createSql(r, name, cols, kind === 'create-if'));
        if (!exists) state.tables.push({ name, cols, rows: [] });
      }
    }
    let failsAt = -1;
    if (r.chance(0.25)) { stmts.push(failing(r, state)); failsAt = stmts.length - 1; }
    // a syntax error anywhere: nothing runs (an empty statement only between two others, where it surely is one)
    if (r.chance(0.08)) stmts.splice(r.int(0, stmts.length), 0, r.pick(['SELECT 1 +', 'SELECT * FROM', 'DROP TABLE', 'SELECT 1 SELECT 2']));
    else if (stmts.length > 1 && r.chance(0.04)) stmts.splice(r.int(1, stmts.length - 1), 0, '');
    const seps = [';\n', '; ', ';\r\n', ';\n-- next\n', ';\n/* c */\n', ';\n\n'];
    let text = stmts.map((s, i) => (i ? r.pick(seps) : '') + s).join('') + r.pick([';\n', '\n', '', ';', ';\n-- end\n']);
    if (r.chance(0.05)) text = r.pick(['', '-- nothing to do\n', '/* only a comment */', '\n\n']);
    const name = r.pick(['script.sql', 'script.sql', 'jobs/nightly.sql']);
    // a script that may succeed keeps every table in sift's own form (a table written again changes no byte)
    const loose = failsAt >= 0 ? looseAll(r, { tables: start.tables }) : [];
    return done(withFormat(r, 'run', name, 0.3), files(r, db, { loose, more: { [name]: text } }), today(r));
  },
  formats: (r) => {
    const db = makeDb(r, 1, 2);
    const format = r.pick(FORMATS);
    const tb = r.pick(db.tables);
    const sql = r.pick([
      () => `SELECT * FROM ${tb.name}`, () => `SELECT * FROM ${tb.name} WHERE FALSE`, () => `SELECT * FROM ${tb.name} LIMIT 1`, () => query(r, db).sql,
      () => 'SELECT NULL', () => 'SELECT NULL AS x, 1, 2.50 AS price', () => "SELECT 1 / 3 AS third, -0.5, 'a\"b', 'x|y', 'line\nbreak', 'cr\r\nlf', ''",
      () => "SELECT 'a,b', 'q\"uote', 'a''b'", () => 'SELECT TRUE, FALSE, CAST(NULL AS BOOLEAN), TODAY()', () => "SELECT '\\n', 'tab\there', 'é', '😀'",
      () => 'SELECT 9223372036854775807, -9223372036854775807 - 1, 999999999999999999.999999', () => `SELECT COUNT(*) FROM ${tb.name}`,
      () => insert(r, db, tb, { select: false }),
    ])();
    return done(withFormat(r, 'query', sql, 0.9, format), files(r, db), today(r));
  },
  'csv-reading': (r) => {
    const db = makeDb(r, 1, 2);
    if (r.chance(0.3)) db.tables.push(oneColumn(r));
    for (const t of db.tables) for (const row of t.rows) for (let i = 0; i < row.length; i++) if (t.cols[i].type === 'text' && r.chance(0.3)) row[i] = r.pick(WORDS);
    const tb = r.pick(db.tables);
    const args = r.pick([
      () => q(r, `SELECT * FROM ${tb.name}`, 0.6), () => q(r, query(r, db).sql), () => ['schema', r.chance(0.3) ? tb.name.toUpperCase() : tb.name],
      () => q(r, `SELECT COUNT(*), ${tb.cols.map((c) => `COUNT(${c.name})`).join(', ')} FROM ${tb.name}`),
      () => q(r, `DELETE FROM ${tb.name} WHERE ${tb.cols[0].name} IS NULL`),
    ])();
    return done(args, files(r, db, { loose: db.tables.map((t) => t.name) }), today(r));
  },
  'table-errors': (r) => {
    const db = makeDb(r, 1, 3);
    const tb = r.pick(db.tables);
    // one entry per row (a quoted field may hold a line break), so row k is lines[k]
    const lines = [tableText(tb).split('\n', 1)[0], ...tb.rows.map((row) => row.map((v, j) => field(tb.cols[j].type, v)).join(','))];
    const header = () => r.pick(['id', 'id:int', 'id: integer', 'id :integer', ' id:integer', 'id:integer:x', '1a:text', 'order:integer', 'a b:text',
      'id:integer,', '', `${lines[0]},${tb.cols[0].name.toUpperCase()}:text`, 'select:text', 'a-b:text']);
    const BAD = {
      integer: ['12x', ' 5', '5 ', '+5', '1.0', '9223372036854775808', '-9223372036854775809', '--1', '1_000', '"1,5"'],
      decimal: ['.5', '5.', '1e3', '1.1234567', '1234567890123456789', '+1.5', '"1,5"', ' 1.5', 'NaN', '1.5.0'],
      boolean: ['TRUE', 'True', 'yes', '1', 't', ' true', 'false '],
      date: ['2023-02-29', '2024-1-05', '2024-13-01', '0000-01-01', '24-01-05', '2024/01/05', '2024-01-05 ', '1900-02-29', '2024-04-31'],
      text: ['"unclosed', '"ab"c', 'ab"c', '"a""b'],
    };
    const kind = r.pick(['value', 'value', 'shape', 'header', 'empty']);
    if (kind === 'header') lines[0] = header();
    else if (kind === 'empty') lines.length = 0;
    else if (kind === 'shape' || !tb.rows.length) {
      const at = r.int(1, lines.length);
      lines.splice(at, at < lines.length ? 1 : 0, r.pick([
        `${lines[at] ?? '1'},extra`, tb.cols.length > 1 ? '' : '"unclosed', tb.cols.map(() => '1').slice(1).join(',') || '"x"y', '"a\nb', 'x,"y',
      ]));
    } else {
      const at = r.int(1, lines.length - 1);
      const i = r.int(0, tb.cols.length - 1);
      const row = tb.rows[at - 1].map((v, j) => field(tb.cols[j].type, v));
      row[i] = r.pick(BAD[tb.cols[i].type]);
      lines[at] = row.join(',');
    }
    const text = lines.length ? lines.join(r.pick(['\n', '\r\n'])) + '\n' : r.pick(['', '﻿']);
    const other = db.tables.find((t) => t !== tb);
    const args = r.pick([
      () => q(r, `SELECT * FROM ${tb.name}`), () => q(r, query(r, { tables: [tb] }, { from: true }).sql), () => ['schema', tb.name], () => ['tables'],
      () => q(r, `INSERT INTO ${tb.name} VALUES (${tb.cols.map(() => 'NULL').join(', ')})`), () => q(r, `CREATE TABLE IF NOT EXISTS ${tb.name} (a integer)`),
      () => q(r, other ? `SELECT * FROM ${other.name}` : 'SELECT 1'), () => q(r, other ? `SELECT * FROM ${other.name} JOIN ${tb.name} ON TRUE` : `SELECT COUNT(*) FROM ${tb.name}`),
      () => q(r, `SELECT 1 + 'a' FROM ${tb.name}`), () => q(r, `SELECT (SELECT COUNT(*) FROM ${tb.name})`),
    ])();
    const out = files(r, db);
    out[`db/${tb.name}.csv`] = Buffer.from(text);
    return done(args, out, today(r));
  },
  boundaries: (r) => {
    const tb = { name: 'bounds', cols: [{ name: 'i', type: 'integer' }, { name: 'd', type: 'decimal' }, { name: 'day', type: 'date' }], rows: [] };
    for (let k = r.int(1, 4); k > 0; k--) {
      tb.rows.push([r.pick([MAX_INT, MIN_INT, '0', '-1', '1', null, String(r.int(-9, 9))]), r.pick([BIG_DEC, `-${BIG_DEC}`, '0.000001', '-0.000001', '0.0', null, '1.5']),
        r.pick(['0001-01-01', '9999-12-31', '2000-02-29', '1999-12-31', null, '9999-12-01', '0001-01-31'])]);
    }
    const db = { tables: [tb] };
    const sql = r.pick([
      'SELECT i + 1 FROM bounds', 'SELECT i - 1 FROM bounds', 'SELECT -i FROM bounds', 'SELECT ABS(i) FROM bounds', 'SELECT i * 2 FROM bounds', 'SELECT SUM(i) FROM bounds',
      'SELECT MAX(i), MIN(i), MAX(d), MIN(d), MAX(day), MIN(day) FROM bounds', 'SELECT CAST(i AS DECIMAL) FROM bounds', 'SELECT i / 1 FROM bounds', 'SELECT i / 10 FROM bounds',
      'SELECT i / -1 FROM bounds', 'SELECT i % -1 FROM bounds', 'SELECT d + 0.000001 FROM bounds', 'SELECT d * 2 FROM bounds', 'SELECT d - d FROM bounds',
      'SELECT FLOOR(d), CEIL(d) FROM bounds', 'SELECT CAST(d AS INTEGER) FROM bounds', 'SELECT day + 1 FROM bounds', 'SELECT day - 1 FROM bounds',
      'SELECT ADD_MONTHS(day, 1) FROM bounds', 'SELECT ADD_MONTHS(day, -1) FROM bounds', 'SELECT YEAR(day), MONTH(day), DAY(day) FROM bounds', 'SELECT * FROM bounds ORDER BY i',
      'SELECT * FROM bounds ORDER BY d DESC', 'SELECT * FROM bounds ORDER BY day NULLS FIRST', 'SELECT * FROM bounds WHERE i > 9223372036854775806', 'SELECT i FROM bounds WHERE d < 0',
      'SELECT 9223372036854775807 + 0', 'SELECT 9223372036854775807 + 1', 'SELECT -9223372036854775807 - 1', 'SELECT -9223372036854775807 - 2',
      'SELECT 999999999999999999.999999 + 0.000001', 'SELECT 999999999999999999.999999', 'SELECT -999999999999999999.999999 - 0.000001',
      "SELECT CAST('9999-12-31' AS DATE) + 1", "SELECT CAST('0001-01-01' AS DATE) - 1", 'SELECT TODAY() + 1', 'SELECT TODAY() - 1', 'SELECT 4611686018427387904 * 2',
      'SELECT 3037000500 * 3037000500', 'SELECT 3037000499 * 3037000499', 'SELECT 1000000000000000000 / 1', 'SELECT 999999999999999999 / 1',
      'SELECT CAST(1000000000000000000 AS DECIMAL)', 'SELECT CAST(999999999999999999 AS DECIMAL)', "SELECT CAST('-9223372036854775808' AS INTEGER)",
      "SELECT CAST('9223372036854775808' AS INTEGER)", "SELECT CAST('999999999999999999.999999' AS DECIMAL)", "SELECT CAST('1000000000000000000' AS DECIMAL)",
      'INSERT INTO bounds (d) VALUES (1000000000000000000)', 'INSERT INTO bounds (i, d) VALUES (9223372036854775807, 999999999999999999)',
      "SELECT ADD_MONTHS(CAST('9999-12-31' AS DATE), 1)", "SELECT ADD_MONTHS(CAST('0001-01-31' AS DATE), -1)", "SELECT ADD_MONTHS(CAST('0001-01-31' AS DATE), 1)",
      'SELECT 999999999999999999.999999 * 1.0', 'SELECT 999999999999999999.999999 / 0.5', 'SELECT -(-9223372036854775807 - 1)', 'SELECT i, d, day FROM bounds',
    ]);
    return done(q(r, sql, 0.4), files(r, db, { loose: r.chance(0.4) ? ['bounds'] : [] }), r.pick([today(r), '9999-12-31', '0001-01-01']));
  },
  syntax: (r) => {
    const db = makeDb(r, 2, 3);
    let sql;
    if (r.chance(0.3)) {
      // a valid query with a character no token starts with, outside its text literals
      const parts = query(r, db).sql.split(/('(?:[^']|'')*')/);
      const spaces = parts.flatMap((s, i) => (i % 2 ? [] : [...s.matchAll(/ /g)].map((m) => [i, m.index])));
      const [i, at] = r.pick(spaces);
      parts[i] = `${parts[i].slice(0, at)} ${r.pick(['$', '?', '{', '}', '~', '^', '&', '`', '#', '"', '[', ':', '\\'])}${parts[i].slice(at)}`;
      sql = parts.join('');
    } else sql = pickFilled(r, SYNTAX, db);
    return done(q(r, sql, 0.2), files(r, db), today(r));
  },
  lexing: (r) => {
    const db = makeDb(r, 1, 2);
    // no line comment in the base: mangling may put a line break into it
    const base = r.chance(0.2) ? r.pick(["SELECT 'it''s', 'two\nlines', ''''", 'SELECT /* a */ 1 /* b -- c */', 'SELECT 1 != 2, 1 <> 2',
      "SELECT 'a' AS Mixed_Case", 'SELECT 007, 0.50, 10.000000']) : query(r, db).sql;
    const sql = `${r.pick(['', '\n', '  ', '-- lead\n', '/* lead */ ', '\r\n'])}${mangle(r, base)}${r.pick(['', ' ', '\n', ';', ' ;\n', ' -- end', '\n-- end\n'])}`;
    return done(q(r, sql, 0.2), files(r, db), today(r));
  },
  'type-errors': (r) => {
    const db = makeDb(r, 2, 3);
    return done(q(r, pickFilled(r, TYPE_ERRORS, db), 0.2), files(r, db), today(r));
  },
  names: (r) => {
    const db = makeDb(r, 2, 3);
    return done(q(r, pickFilled(r, NAME_ERRORS, db), 0.2), files(r, db), today(r));
  },
  'aggregate-errors': (r) => {
    const db = makeDb(r, 2, 3);
    return done(q(r, pickFilled(r, AGG_ERRORS, db), 0.2), files(r, db), today(r));
  },
  usage: (r) => {
    const db = makeDb(r, 1, 2);
    const t = db.tables[0].name;
    const args = r.pick([
      () => [], () => ['help'], () => ['select', 'SELECT 1'], () => ['query'], () => ['query', 'SELECT 1', 'SELECT 2'], () => ['query', 'SELECT 1', '--format'],
      () => ['query', 'SELECT 1', '--format', 'xml'], () => ['query', 'SELECT 1', '--format', 'csv', '--format', 'json'],
      () => ['query', 'SELECT 1', '--format', 'csv', '--format', 'csv'], () => ['query', 'SELECT 1', '--verbose'], () => ['query', '--format=csv', 'SELECT 1'],
      () => ['query', 'SELECT 1', '-f', 'csv'], () => ['run'], () => ['run', 'a.sql', 'b.sql'], () => ['run', 'script.sql', '--format', 'md'], () => ['tables', 'x'],
      () => ['tables', '--format', 'csv'], () => ['schema'], () => ['schema', t, t], () => ['schema', 'select'], () => ['schema', '1abc'], () => ['schema', `${t}.csv`],
      () => ['schema', 'a-b'], () => ['schema', t, '--format', 'json'], () => ['--format', 'csv'], () => ['--help'], () => ['query', 'SELECT 1', '--Format', 'csv'],
      () => ['query', '--format', 'csv'], () => ['query', '--select'], () => ['query', 'SELECT 1', '--format', '--csv'], () => ['schema', ''], () => ['query', 'SELECT 1', '--'],
      () => ['run', '--format', 'json'],
    ])();
    // usage comes first: a bad clock or a missing data directory changes nothing
    const now = r.chance(0.2) ? '2024-02-30' : today(r);
    return done(args, r.chance(0.15) ? null : files(r, db, { more: { 'script.sql': 'SELECT 1;' } }), now);
  },
  environment: (r) => {
    const db = makeDb(r, 1, 2);
    const t = db.tables[0].name;
    const cmd = r.pick([() => ['tables'], () => ['schema', t], () => q(r, 'SELECT 1'), () => q(r, `SELECT * FROM ${t}`), () => ['run', 'script.sql'], () => q(r, 'SELECT 1 +')]);
    const kind = r.pick(['today', 'today', 'no-db', 'db-file', 'no-script', 'edge-today']);
    const script = { 'script.sql': `SELECT COUNT(*) FROM ${t};` };
    if (kind === 'today') return done(cmd(), files(r, db, { more: script }), r.pick(['2024-02-30', '2024-2-03', 'today', '20240315', '2023-02-29', '2024-03-15 ', '2024-13-01', '1900-02-29', '15/03/2024']));
    if (kind === 'edge-today') return done(r.pick([() => q(r, 'SELECT TODAY(), YEAR(TODAY()), DAY(TODAY())'), cmd])(), files(r, db, { more: script }), r.pick(['2024-02-29', '0001-01-01', '9999-12-31', '2000-02-29']));
    if (kind === 'no-db') return done(cmd(), r.chance(0.3) ? null : { 'script.sql': Buffer.from(script['script.sql']), [`data/${t}.csv`]: Buffer.from(tableText(db.tables[0])) }, today(r));
    if (kind === 'db-file') return done(cmd(), { 'script.sql': Buffer.from(script['script.sql']), db: Buffer.from(tableText(db.tables[0])) }, today(r));
    return done(r.pick([['run', 'nope.sql'], ['run', 'jobs/script.sql'], ['run', 'nope.sql', '--format', 'csv']]), files(r, db, { more: script }), today(r));
  },
  precedence: (r) => {
    const db = makeDb(r, 1, 3);
    const t = db.tables[0];
    const c = t.cols[0].name;
    const broken = { ...files(r, db), [`db/${t.name}.csv`]: Buffer.from(`${c}:integer\nx\n`) };
    const pick = r.pick([
      () => done(['query'], files(r, db), '2024-02-30'), () => done(['query', 'SELECT 1 +', '--format', 'xml'], null, today(r)),
      () => done(q(r, 'SELECT 1 +'), files(r, db), r.pick(['2024-02-30', 'x'])), () => done(q(r, 'SELECT * FROM'), null, today(r)),
      () => done(q(r, 'SELECT * FROM nothere WHERE'), files(r, db), today(r)), () => done(q(r, `SELECT 1 + 'a' FROM ${t.name} WHERE`), files(r, db), today(r)),
      () => done(q(r, "SELECT 1 + 'a' FROM nothere"), files(r, db), today(r)), () => done(q(r, `SELECT 1 + 'a' FROM ${t.name}`), broken, today(r)),
      () => done(q(r, `SELECT * FROM ${t.name} JOIN nothere ON ${t.name}.nosuch = 1`), files(r, db), today(r)),
      () => done(q(r, `SELECT CAST('x' AS INTEGER), 1 + 'a' FROM ${t.name}`), files(r, db), today(r)),
      () => done(q(r, `SELECT nosuch, CAST('x' AS INTEGER) FROM ${t.name}`), files(r, db), today(r)),
      () => done(q(r, `SELECT * FROM nothere JOIN ${t.name} ON TRUE`), broken, today(r)),
      () => done(q(r, `SELECT (SELECT ${c} FROM ${t.name} UNION ALL SELECT ${c} FROM ${t.name}) FROM ${t.name} WHERE FALSE`), files(r, db), today(r)),
      () => done(q(r, `SELECT ${c} FROM ${t.name} WHERE FALSE AND CAST('x' AS INTEGER) = 1`), files(r, db), today(r)),
      () => done(q(r, `SELECT CASE WHEN FALSE THEN CAST('x' AS INTEGER) ELSE 1 END, COALESCE(1, CAST('y' AS INTEGER))`), files(r, db), today(r)),
      () => done(q(r, `SELECT CAST('x' AS INTEGER) FROM ${t.name} LIMIT 0`), files(r, db), today(r)),
      () => done(q(r, `SELECT CAST('x' AS INTEGER) FROM ${t.name} WHERE FALSE`), files(r, db), today(r)),
      () => {
        const s = r.pick([
          `SELECT CAST('x' AS INTEGER);\nSELECT 1 +`, `SELECT 1 + 'a';\nSELECT * FROM nothere`, `SELECT * FROM nothere;\nSELECT 1 + 'a'`,
          `DELETE FROM ${t.name};\nSELECT CAST('x' AS INTEGER)`, `DROP TABLE ${t.name};\nSELECT * FROM ${t.name}`, `CREATE TABLE tmp (a integer);\nINSERT INTO tmp VALUES (1);\nSELECT * FROM tmp`,
          `INSERT INTO ${t.name} (${c}) VALUES (NULL);\nSELECT 1 / 0;\nSELECT nosuch FROM ${t.name}`, `DROP TABLE ${t.name};\nCREATE TABLE ${t.name} (z text);\nINSERT INTO ${t.name} VALUES ('a')`,
          `CREATE TABLE tmp (a integer);\nDROP TABLE tmp`, `CREATE TABLE tmp (a integer);\nCREATE TABLE tmp (b text)`, `DROP TABLE IF EXISTS tmp;\nCREATE TABLE IF NOT EXISTS ${t.name} (a integer)`,
        ]);
        return done(withFormat(r, 'run', 'script.sql', 0.2), files(r, db, { more: { 'script.sql': s } }), today(r));
      },
    ]);
    return pick();
  },
  commands: (r) => {
    const db = makeDb(r, 0, 4);
    if (r.chance(0.2)) db.tables.push(oneColumn(r, r.pick(['t1', 't2', 'log2024'])));
    const out = files(r, db, { extras: r.chance(0.4) ? 3 : 0 });
    const tb = db.tables.length ? r.pick(db.tables) : null;
    if (tb && r.chance(0.2)) out[`db/${tb.name}.csv`] = Buffer.from(`${tb.cols[0].name}:integer\n"oops\n`);
    const args = r.pick([
      () => ['tables'], () => ['tables'], () => ['schema', tb ? r.pick([tb.name, tb.name.toUpperCase(), tb.name[0].toUpperCase() + tb.name.slice(1)]) : 'people'],
      () => ['schema', r.pick(['nothere', 'archive', 'notes', 'mixed_case', 'old'])], () => ['schema', tb?.name ?? 'people'],
    ])();
    return done(args, out, today(r));
  },
  'non-tables': (r) => {
    const db = makeDb(r, 1, 2);
    const out = files(r, db, { extras: 5 });
    const tb = r.pick(db.tables);
    const args = r.pick([
      () => ['tables'], () => q(r, `SELECT * FROM ${r.pick(['Archive', 'archive', 'notes', 'old', 'Mixed_Case', 'hidden', 'people_csv'])}`),
      () => q(r, `DROP TABLE ${r.pick(['archive', 'mixed_case', 'old'])}`), () => q(r, `DROP TABLE IF EXISTS ${r.pick(['archive', 'mixed_case'])}`),
      () => q(r, insert(r, db, tb, { select: false })), () => q(r, remove(r, db, tb)), () => q(r, createSql(r, r.pick(['tags', 'stock']), newColumns(r))),
      () => q(r, `DROP TABLE ${tb.name}`), () => ['schema', r.pick(['Archive', 'select', 'mixed_case'])],
    ])();
    return done(args, out, today(r));
  },
};
