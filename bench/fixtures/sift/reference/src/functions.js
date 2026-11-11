// The function list (text, number and date functions): each one's argument types, its result type, and what it
// works out. COALESCE, NULLIF and CASE are in expr.js, the aggregates in the grouping module. A function gives NULL
// when any argument is NULL; an unknown function, a wrong number of arguments or a wrong type is exit 5.
import { checkError, runtimeError } from './errors.js';
import { SCALE, checkDate, checkDec, checkInt, civil, dayNumber, divFloor, divRound, isNumber, monthDays } from './values.js';

const asciiUpper = (s) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** An argument kind: which types it takes. */
const ACCEPTS = {
  text: (t) => t === 'text',
  integer: (t) => t === 'integer',
  number: isNumber,
  date: (t) => t === 'date',
};

const FUNCTIONS = {
  length: { args: ['text'], type: 'integer', fn: ([s]) => BigInt(s.length) },
  upper: { args: ['text'], type: 'text', fn: ([s]) => asciiUpper(s) },
  lower: { args: ['text'], type: 'text', fn: ([s]) => asciiLower(s) },
  trim: { args: ['text'], type: 'text', fn: ([s]) => s.replace(/^ +| +$/g, '') },
  substr: { args: ['text', 'integer'], optional: ['integer'], type: 'text', fn: ([s, start, len]) => {
    if (start < 1n) throw runtimeError('SUBSTR start below 1');
    if (len !== undefined && len < 0n) throw runtimeError('SUBSTR length below 0');
    if (start > BigInt(s.length)) return '';
    const from = Number(start) - 1;
    const n = len === undefined ? s.length : Number(len > BigInt(s.length) ? BigInt(s.length) : len);
    return s.slice(from, from + n);
  } },
  replace: { args: ['text', 'text', 'text'], type: 'text', fn: ([s, from, to]) => (from === '' ? s : s.split(from).join(to)) },
  instr: { args: ['text', 'text'], type: 'integer', fn: ([s, sub]) => BigInt(s.indexOf(sub) + 1) },

  abs: { args: ['number'], type: (ts) => ts[0] ?? 'integer', fn: ([n], ts) => {
    if (n >= 0n) return n;
    return ts[0] === 'integer' ? checkInt(-n) : -n;
  } },
  round: { args: ['number'], optional: ['integer'], type: (ts) => ts[0] ?? 'integer', fn: ([n, d], ts) => {
    const digits = d ?? 0n;
    if (digits < 0n || digits > 6n) throw runtimeError(`ROUND takes 0 to 6 digits, not ${digits}`);
    if (ts[0] !== 'decimal') return n;
    const unit = 10n ** (6n - digits);
    return checkDec(divRound(n, unit) * unit);
  } },
  floor: { args: ['number'], type: 'integer', fn: ([n], ts) => (ts[0] === 'decimal' ? divFloor(n, SCALE) : n) },
  ceil: { args: ['number'], type: 'integer', fn: ([n], ts) => (ts[0] === 'decimal' ? -divFloor(-n, SCALE) : n) },

  today: { args: [], type: 'date', fn: (_, ts, rt) => rt.today },
  year: { args: ['date'], type: 'integer', fn: ([d]) => BigInt(civil(d).y) },
  month: { args: ['date'], type: 'integer', fn: ([d]) => BigInt(civil(d).m) },
  day: { args: ['date'], type: 'integer', fn: ([d]) => BigInt(civil(d).d) },
  weekday: { args: ['date'], type: 'integer', fn: ([d]) => BigInt((d % 7) + 1) },
  add_months: { args: ['date', 'integer'], type: 'date', fn: ([d, n]) => {
    const { y, m, d: day } = civil(d);
    const months = BigInt(y) * 12n + BigInt(m - 1) + n;
    if (months < 12n || months > 9999n * 12n + 11n) throw runtimeError('date out of range');
    const y2 = Number(months / 12n);
    const m2 = Number(months % 12n) + 1;
    return checkDate(dayNumber(y2, m2, Math.min(day, monthDays(y2, m2))));
  } },
};

/** A call of a function of the list over compiled arguments: checked now, `{ type, ev }`. */
export function callFunction(name, args) {
  const f = FUNCTIONS[name];
  if (!f) throw checkError(`unknown function: ${name.toUpperCase()}`);
  const kinds = [...f.args, ...(f.optional ?? [])];
  if (args.length < f.args.length || args.length > kinds.length) throw checkError(`wrong number of arguments to ${name.toUpperCase()}`);
  const types = args.map((a) => a.type);
  types.forEach((t, k) => {
    if (t !== null && !ACCEPTS[kinds[k]](t)) throw checkError(`${name.toUpperCase()} does not take ${t} as argument ${k + 1}`);
  });
  const type = typeof f.type === 'function' ? f.type(types) : f.type;
  return { type, ev: (row, rt) => {
    const vals = args.map((a) => a.ev(row, rt));
    if (vals.some((v) => v === null)) return null;
    return f.fn(vals, types, rt);
  } };
}
