// Types and values. A value's type is always known before a statement runs, so a value itself is untagged:
//   integer  a bigint
//   decimal  a bigint counting millionths (2.5 is 2500000n)
//   text     a string
//   boolean  a boolean
//   date     a number, the days since 0001-01-01 (which is 0)
//   NULL     null, in every type
// The type of a bare `NULL` is null.
import { runtimeError } from './errors.js';

export const TYPES = ['integer', 'decimal', 'text', 'boolean', 'date'];

export const INT_MIN = -(2n ** 63n);
export const INT_MAX = 2n ** 63n - 1n;
/** A decimal's millionths per unit, and its size limit (10^18) in millionths. */
export const SCALE = 1_000_000n;
export const DEC_LIMIT = 10n ** 24n;

export const isNumber = (t) => t === 'integer' || t === 'decimal';

// --- integers and decimals -------------------------------------------------------------------------------------------

/** An integer result, or exit 6 when it leaves the integer range. */
export function checkInt(v) {
  if (v < INT_MIN || v > INT_MAX) throw runtimeError('integer out of range');
  return v;
}

/** A decimal result, or exit 6 when it is 10^18 or more in size. */
export function checkDec(v) {
  if (v >= DEC_LIMIT || v <= -DEC_LIMIT) throw runtimeError('decimal out of range');
  return v;
}

/** An integer as a decimal (exit 6 outside the decimal range). */
export const intToDec = (v) => checkDec(v * SCALE);

/** n / d rounded to the nearest integer, a half going away from zero. */
export function divRound(n, d) {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const abs = (x) => (x < 0n ? -x : x);
  if (2n * abs(r) >= abs(d)) return (n < 0n) === (d < 0n) ? q + 1n : q - 1n;
  return q;
}

/** n / d rounded toward minus infinity. */
export function divFloor(n, d) {
  const q = n / d;
  return (n % d !== 0n && (n < 0n) !== (d < 0n)) ? q - 1n : q;
}

const INT_TEXT = /^-?\d+$/;
const DEC_TEXT = /^-?(\d+)(?:\.(\d{1,6}))?$/;

/** A text written as a table file's integer, or undefined. */
export function parseInt64(s) {
  if (!INT_TEXT.test(s)) return undefined;
  const v = BigInt(s);
  return v < INT_MIN || v > INT_MAX ? undefined : v;
}

/** A text written as a table file's decimal, or undefined. */
export function parseDecimal(s) {
  const m = DEC_TEXT.exec(s);
  if (!m || m[1].length > 18) return undefined;
  const neg = s.startsWith('-');
  const v = BigInt(m[1]) * SCALE + BigInt((m[2] ?? '').padEnd(6, '0'));
  return neg ? -v : v;
}

/** A decimal as sift prints it: `2.5`, `3.0`, `-0.125`, never `-0.0`. */
export function printDecimal(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / SCALE).toString();
  const frac = (a % SCALE).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// --- dates -----------------------------------------------------------------------------------------------------------

export const DATE_MIN = 0;
/** The day number of 9999-12-31. */
export const DATE_MAX = 3652058;

/** The days from 0001-01-01 to y-m-d (proleptic Gregorian). */
export function dayNumber(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 306;
}

/** A day number as { y, m, d }. */
export function civil(n) {
  const z = n + 306;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const monthDays = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** A text written `YYYY-MM-DD` that is a real date in range, as its day number, or undefined. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > monthDays(y, mo)) return undefined;
  return dayNumber(y, mo, d);
}

export function printDate(n) {
  const { y, m, d } = civil(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A date result, or exit 6 outside 0001-01-01 to 9999-12-31. */
export function checkDate(n) {
  if (n < DATE_MIN || n > DATE_MAX) throw runtimeError('date out of range');
  return n;
}

/** The local date today, as a day number. */
export function localToday() {
  const now = new Date();
  return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// --- printing, comparing ---------------------------------------------------------------------------------------------

/** A value of a type as sift prints it (NULL as null: each format says how to show it). */
export function print(type, v) {
  if (v === null) return null;
  switch (type) {
    case 'integer': return v.toString();
    case 'decimal': return printDecimal(v);
    case 'date': return printDate(v);
    case 'boolean': return v ? 'true' : 'false';
    default: return v;
  }
}

/** Two values that are not NULL, of one type: below 0, 0 or above 0. Texts by UTF-16 code units. */
export function compareSame(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A value as the library gives it: a bigint for an integer, the printed text for a decimal or a date. */
export function toLibrary(type, v) {
  if (v === null) return null;
  if (type === 'decimal' || type === 'date') return print(type, v);
  return v;
}
