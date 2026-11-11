// Expressions: checked against the tables' columns before anything runs (names, types, aggregates: exit 5), and
// compiled into `{ type, ev }`, where `ev(row, rt)` works the value out for one row (`rt`: the run, e.g. today).
// Operands and arguments are worked out left to right; AND, OR, CASE and COALESCE stop as the brief says.
import { checkError, runtimeError } from './errors.js';
import { callFunction } from './functions.js';
import { isAggregateName } from './parser.js';
import { compileInSubquery, compileScalarSubquery } from './subqueries.js';
import {
  SCALE, checkDate, checkDec, checkInt, compareSame, divRound, intToDec, isNumber, parseDate, parseDecimal, parseInt64, print,
} from './values.js';

// --- the names a query sees ------------------------------------------------------------------------------------------

/**
 * The tables of a query, each known by its alias or its name, their columns side by side in one row:
 * source k's columns start at `offset`.
 */
export class Scope {
  constructor() {
    this.sources = [];
    this.width = 0;
  }

  /** A table joins the scope, known as `known`. Two tables known by one name are exit 5. */
  add(known, table) {
    if (this.sources.some((s) => s.known === known)) throw checkError(`two tables are known as ${known}`);
    const src = { known, table, columns: table.columns, offset: this.width };
    this.sources.push(src);
    this.width += table.columns.length;
    return src;
  }

  /** A column reference: its place in the row and its type. Unknown or ambiguous names are exit 5. */
  resolve(table, name) {
    if (table !== null) {
      const src = this.sources.find((s) => s.known === table);
      if (!src) throw checkError(`no such table: ${table}`);
      const k = src.columns.findIndex((c) => c.name === name);
      if (k < 0) throw checkError(`no such column: ${table}.${name}`);
      return { index: src.offset + k, type: src.columns[k].type };
    }
    const found = [];
    for (const src of this.sources) {
      const k = src.columns.findIndex((c) => c.name === name);
      if (k >= 0) found.push({ index: src.offset + k, type: src.columns[k].type });
    }
    if (found.length === 0) throw checkError(`no such column: ${name}`);
    if (found.length > 1) throw checkError(`ambiguous column: ${name}`);
    return found[0];
  }
}

// --- types -----------------------------------------------------------------------------------------------------------

const TYPE_NAME = (t) => (t === null ? 'NULL' : t);

/** Two types that compare: one type, two numbers, a text and a date; NULL with anything. */
export function comparable(a, b) {
  if (a === null || b === null || a === b) return true;
  if (isNumber(a) && isNumber(b)) return true;
  return (a === 'text' && b === 'date') || (a === 'date' && b === 'text');
}

function needComparable(a, b, what) {
  if (!comparable(a, b)) throw checkError(`${what} cannot compare ${TYPE_NAME(a)} with ${TYPE_NAME(b)}`);
}

/** A value of type `a` compared with one of type `b`: below 0, 0 or above 0, or null when either is NULL. */
export function comparer(a, b) {
  const conv = (from, to) => {
    if (from === 'integer' && to === 'decimal') return (v) => v * SCALE;
    if (from === 'text' && to === 'date') return (v) => {
      const d = parseDate(v);
      if (d === undefined) throw runtimeError(`not a date: ${JSON.stringify(v)}`);
      return d;
    };
    return (v) => v;
  };
  const ca = conv(a, b);
  const cb = conv(b, a);
  return (x, y) => (x === null || y === null ? null : compareSame(ca(x), cb(y)));
}

/** The one type of several results (COALESCE, CASE): one type, or integers and decimals as a decimal; NULL anywhere. */
export function unify(types, what) {
  const set = new Set(types.filter((t) => t !== null));
  if (set.size === 0) return null;
  if (set.size === 1) return [...set][0];
  if (set.size === 2 && set.has('integer') && set.has('decimal')) return 'decimal';
  throw checkError(`${what} mixes ${[...set].join(' and ')}`);
}

/** A compiled expression turned into `type` where its own type differs (an integer into a decimal). */
export function coerce(c, type) {
  if (c.type === 'integer' && type === 'decimal') {
    const ev = c.ev;
    return { type, ev: (row, rt) => { const v = ev(row, rt); return v === null ? null : intToDec(v); } };
  }
  return { type, ev: c.ev };
}

const needBoolean = (c, what) => {
  if (c.type !== null && c.type !== 'boolean') throw checkError(`${what} takes a boolean, not ${c.type}`);
};

// --- compiling -------------------------------------------------------------------------------------------------------

/**
 * Compile `node` in `cx`: `{ scope, hook?, aggregate?, aggregateWhere? }`. `hook(node, cx)` may compile a node itself
 * (grouping does, for its GROUP BY items); `aggregate(node, cx)` compiles an aggregate call where one is allowed.
 */
export function compile(node, cx) {
  if (cx.hook) {
    const h = cx.hook(node, cx);
    if (h) return h;
  }
  switch (node.k) {
    case 'lit': return literal(node);
    case 'col': {
      const { index, type } = cx.scope.resolve(node.table, node.name);
      return { type, ev: (row) => row[index] };
    }
    case 'paren': return compile(node.e, cx);
    case 'neg': return negate(compile(node.e, cx));
    case 'bin': return binary(node.op, compile(node.l, cx), compile(node.r, cx));
    case 'cmp': return comparison(node.op, compile(node.l, cx), compile(node.r, cx));
    case 'and': case 'or': return logic(node.k, compile(node.l, cx), compile(node.r, cx));
    case 'not': {
      const e = compile(node.e, cx);
      needBoolean(e, 'NOT');
      return { type: 'boolean', ev: (row, rt) => { const v = e.ev(row, rt); return v === null ? null : !v; } };
    }
    case 'isnull': {
      const e = compile(node.e, cx);
      return { type: 'boolean', ev: (row, rt) => (e.ev(row, rt) === null) !== node.not };
    }
    case 'in': return inList(node.not, compile(node.e, cx), node.list.map((x) => compile(x, cx)));
    case 'insub': return compileInSubquery(node, cx);
    case 'sub': return compileScalarSubquery(node, cx);
    case 'like': return like(node.not, compile(node.l, cx), compile(node.r, cx));
    case 'between': return between(node.not, compile(node.e, cx), compile(node.lo, cx), compile(node.hi, cx));
    case 'cast': return cast(compile(node.e, cx), node.type);
    case 'case': return caseExpr(node, cx);
    case 'call': {
      if (isAggregateName(node.name)) {
        if (!cx.aggregate) throw checkError(`${node.name.toUpperCase()} is not allowed ${cx.aggregateWhere ?? 'here'}`);
        return cx.aggregate(node, cx);
      }
      if (node.name === 'coalesce') return coalesce(node.args.map((a) => compile(a, cx)));
      if (node.name === 'nullif') return nullif(node.args.map((a) => compile(a, cx)));
      return callFunction(node.name, node.args.map((a) => compile(a, cx)));
    }
    default: throw new Error(`unknown expression kind ${node.k}`);
  }
}

/** True when `node` holds an aggregate call outside any subquery. */
export function hasAggregate(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasAggregate);
  if (node.k === 'sub' || node.k === 'insub') return hasAggregate(node.e);
  if (node.k === 'call' && isAggregateName(node.name)) return true;
  for (const [key, v] of Object.entries(node)) if (key !== 'select' && v && typeof v === 'object' && hasAggregate(v)) return true;
  return false;
}

function literal(node) {
  let v = node.value;
  if (node.type === 'decimal') v = parseDecimal(node.text);
  return { type: node.type, ev: () => v, literal: true };
}

function negate(e) {
  if (e.type !== null && !isNumber(e.type)) throw checkError(`- takes a number, not ${e.type}`);
  const type = e.type ?? 'integer';
  const check = type === 'integer' ? checkInt : checkDec;
  return { type, ev: (row, rt) => { const v = e.ev(row, rt); return v === null ? null : check(-v); } };
}

const both = (l, r, f) => (row, rt) => {
  const a = l.ev(row, rt);
  const b = r.ev(row, rt);
  return a === null || b === null ? null : f(a, b);
};

function binary(op, l, r) {
  if (op === '||') return { type: 'text', ev: both(l, r, (a, b) => print(l.type, a) + print(r.type, b)) };
  const [lt, rt] = [l.type, r.type];
  if (lt === 'date' || rt === 'date') return dateArithmetic(op, l, r);
  if ((lt !== null && !isNumber(lt)) || (rt !== null && !isNumber(rt))) {
    throw checkError(`${op} takes numbers, not ${TYPE_NAME(lt)} and ${TYPE_NAME(rt)}`);
  }
  if (op === '%' && (lt === 'decimal' || rt === 'decimal')) throw checkError('% takes integers only');
  if (lt === 'decimal' || rt === 'decimal') {
    const [a, b] = [coerce(l, 'decimal'), coerce(r, 'decimal')];
    return { type: 'decimal', ev: both(a, b, DEC_OPS[op]) };
  }
  return { type: 'integer', ev: both(l, r, INT_OPS[op]) };
}

const divisor = (b) => {
  if (b === 0n) throw runtimeError('division by zero');
  return b;
};

const INT_OPS = {
  '+': (a, b) => checkInt(a + b),
  '-': (a, b) => checkInt(a - b),
  '*': (a, b) => checkInt(a * b),
  '/': (a, b) => checkInt(a / divisor(b)),
  '%': (a, b) => a % divisor(b),
};

const DEC_OPS = {
  '+': (a, b) => checkDec(a + b),
  '-': (a, b) => checkDec(a - b),
  '*': (a, b) => checkDec(divRound(a * b, SCALE)),
  '/': (a, b) => checkDec(divRound(a * SCALE, divisor(b))),
};

function dateArithmetic(op, l, r) {
  const [lt, rt] = [l.type, r.type];
  const isInt = (t) => t === null || t === 'integer';
  const isDate = (t) => t === null || t === 'date';
  const days = (d, n) => checkDate(d + Number(n));
  if (op === '+' && lt === 'date' && isInt(rt)) return { type: 'date', ev: both(l, r, days) };
  if (op === '+' && isInt(lt) && rt === 'date') return { type: 'date', ev: both(l, r, (n, d) => days(d, n)) };
  if (op === '-' && lt === 'date' && isInt(rt)) return { type: 'date', ev: both(l, r, (d, n) => days(d, -n)) };
  if (op === '-' && isDate(lt) && rt === 'date') return { type: 'integer', ev: both(l, r, (a, b) => BigInt(a - b)) };
  throw checkError(`${op} does not take ${TYPE_NAME(lt)} and ${TYPE_NAME(rt)}`);
}

const TESTS = {
  '=': (c) => c === 0, '<>': (c) => c !== 0, '<': (c) => c < 0, '<=': (c) => c <= 0, '>': (c) => c > 0, '>=': (c) => c >= 0,
};

function comparison(op, l, r) {
  needComparable(l.type, r.type, op);
  const cmp = comparer(l.type, r.type);
  const test = TESTS[op];
  return { type: 'boolean', ev: (row, rt) => {
    const c = cmp(l.ev(row, rt), r.ev(row, rt));
    return c === null ? null : test(c);
  } };
}

function logic(kind, l, r) {
  needBoolean(l, kind.toUpperCase());
  needBoolean(r, kind.toUpperCase());
  if (kind === 'and') {
    return { type: 'boolean', ev: (row, rt) => {
      const a = l.ev(row, rt);
      if (a === false) return false;
      const b = r.ev(row, rt);
      if (b === false) return false;
      return a === null || b === null ? null : true;
    } };
  }
  return { type: 'boolean', ev: (row, rt) => {
    const a = l.ev(row, rt);
    if (a === true) return true;
    const b = r.ev(row, rt);
    if (b === true) return true;
    return a === null || b === null ? null : false;
  } };
}

/** `e IN (values…)` over values already worked out: TRUE on a match, else NULL when a NULL is involved, else FALSE. */
export function inValues(cmps, a, values) {
  let sawNull = a === null;
  let found = false;
  for (let k = 0; k < values.length; k++) {
    const c = cmps[k](a, values[k]);
    if (c === null) sawNull = true;
    else if (c === 0) found = true;
  }
  return found ? true : sawNull ? null : false;
}

function inList(not, e, list) {
  for (const x of list) needComparable(e.type, x.type, 'IN');
  const cmps = list.map((x) => comparer(e.type, x.type));
  return { type: 'boolean', ev: (row, rt) => {
    const a = e.ev(row, rt);
    const values = list.map((x) => x.ev(row, rt));
    const v = inValues(cmps, a, values);
    return v === null ? null : v !== not;
  } };
}

/** Does `text` match the LIKE `pattern` whole: `%` any run, `_` one character, everything else itself. */
export function likeMatch(text, pattern) {
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '_' || (pattern[p] !== '%' && pattern[p] === text[t]))) { t++; p++; continue; }
    if (p < pattern.length && pattern[p] === '%') { starP = p++; starT = t; continue; }
    if (starP >= 0) { p = starP + 1; t = ++starT; continue; }
    return false;
  }
  while (p < pattern.length && pattern[p] === '%') p++;
  return p === pattern.length;
}

function like(not, l, r) {
  for (const c of [l, r]) if (c.type !== null && c.type !== 'text') throw checkError(`LIKE takes texts, not ${c.type}`);
  return { type: 'boolean', ev: both(l, r, (a, b) => likeMatch(a, b) !== not) };
}

function between(not, e, lo, hi) {
  needComparable(e.type, lo.type, 'BETWEEN');
  needComparable(e.type, hi.type, 'BETWEEN');
  const cl = comparer(e.type, lo.type);
  const ch = comparer(e.type, hi.type);
  return { type: 'boolean', ev: (row, rt) => {
    const a = e.ev(row, rt);
    const c1 = cl(a, lo.ev(row, rt));
    const x = c1 === null ? null : c1 >= 0;
    let v;
    if (x === false) v = false;
    else {
      const c2 = ch(a, hi.ev(row, rt));
      const y = c2 === null ? null : c2 <= 0;
      v = y === false ? false : x === null || y === null ? null : true;
    }
    return v === null ? null : v !== not;
  } };
}

// --- casts -----------------------------------------------------------------------------------------------------------

/** The conversion of a value of type `from` to type `to`, or undefined when that is a type error. */
export function castFn(from, to) {
  if (from === null || from === to) return (v) => v;
  switch (to) {
    case 'text': return (v) => print(from, v);
    case 'integer':
      if (from === 'decimal') return (v) => v / SCALE;
      if (from === 'boolean') return (v) => (v ? 1n : 0n);
      if (from === 'text') return (v) => {
        const n = parseInt64(v);
        if (n === undefined) throw runtimeError(`not an integer: ${JSON.stringify(v)}`);
        return n;
      };
      return undefined;
    case 'decimal':
      if (from === 'integer') return intToDec;
      if (from === 'text') return (v) => {
        const n = parseDecimal(v);
        if (n === undefined) throw runtimeError(`not a decimal: ${JSON.stringify(v)}`);
        return n;
      };
      return undefined;
    case 'boolean':
      if (from === 'integer') return (v) => v !== 0n;
      if (from === 'text') return (v) => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        throw runtimeError(`not a boolean: ${JSON.stringify(v)}`);
      };
      return undefined;
    case 'date':
      if (from === 'text') return (v) => {
        const d = parseDate(v);
        if (d === undefined) throw runtimeError(`not a date: ${JSON.stringify(v)}`);
        return d;
      };
      return undefined;
    default: return undefined;
  }
}

function cast(e, to) {
  const f = castFn(e.type, to);
  if (!f) throw checkError(`cannot cast ${e.type} to ${to}`);
  return { type: to, ev: (row, rt) => { const v = e.ev(row, rt); return v === null ? null : f(v); } };
}

// --- CASE, COALESCE, NULLIF ------------------------------------------------------------------------------------------

function caseExpr(node, cx) {
  const base = node.base ? compile(node.base, cx) : null;
  const whens = node.whens.map((w) => ({ when: compile(w.when, cx), then: compile(w.then, cx) }));
  const otherwise = node.else ? compile(node.else, cx) : null;
  for (const w of whens) {
    if (base) needComparable(base.type, w.when.type, 'CASE');
    else needBoolean(w.when, 'CASE WHEN');
  }
  const type = unify([...whens.map((w) => w.then.type), ...(otherwise ? [otherwise.type] : [])], 'CASE');
  const results = whens.map((w) => coerce(w.then, type));
  const fallback = otherwise ? coerce(otherwise, type) : null;
  const cmps = base ? whens.map((w) => comparer(base.type, w.when.type)) : null;
  return { type, ev: (row, rt) => {
    const b = base ? base.ev(row, rt) : null;
    for (let k = 0; k < whens.length; k++) {
      const v = whens[k].when.ev(row, rt);
      const taken = base ? cmps[k](b, v) === 0 : v === true;
      if (taken) return results[k].ev(row, rt);
    }
    return fallback ? fallback.ev(row, rt) : null;
  } };
}

function coalesce(args) {
  if (args.length < 2) throw checkError('COALESCE takes two arguments or more');
  const type = unify(args.map((a) => a.type), 'COALESCE');
  const cs = args.map((a) => coerce(a, type));
  return { type, ev: (row, rt) => {
    for (const c of cs) {
      const v = c.ev(row, rt);
      if (v !== null) return v;
    }
    return null;
  } };
}

function nullif(args) {
  if (args.length !== 2) throw checkError('NULLIF takes two arguments');
  const [a, b] = args;
  needComparable(a.type, b.type, 'NULLIF');
  const cmp = comparer(a.type, b.type);
  return { type: a.type, ev: (row, rt) => {
    const x = a.ev(row, rt);
    const y = b.ev(row, rt);
    return cmp(x, y) === 0 ? null : x;
  } };
}
