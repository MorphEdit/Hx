// The small things every part of ledge checks: dates, months, account names, currencies, prefixes, whitespace and
// the order text is sorted in.

/** The first part of every account name. */
export const ROOTS = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'];

const PART = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

/** Whether `year` is a leap year in the Gregorian calendar. */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The number of days of a month (1–12) of a year. */
export function daysInMonth(year, month) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether `text` is a real date written `YYYY-MM-DD`. */
export function isDate(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const m = DATE.exec(text);
  if (!m) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Whether `text` is a month written `YYYY-MM`. */
export function isMonth(text) {
  if (typeof text !== 'string') {
    return false;
  }
  const m = MONTH.exec(text);
  if (!m) {
    return false;
  }
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/** Whether `text` is a currency: exactly three capital letters. */
export function isCurrency(text) {
  return typeof text === 'string' && CURRENCY.test(text);
}

/**
 * Whether `text` is an account name: parts joined by `:`, the first one of ROOTS, every part a letter followed by
 * letters, digits, `-` and `_`.
 */
export function isAccount(text) {
  if (typeof text !== 'string' || text === '') {
    return false;
  }
  const parts = text.split(':');
  if (!ROOTS.includes(parts[0])) {
    return false;
  }
  return parts.every((part) => PART.test(part));
}

/** Whether account `prefix` is a prefix of `account`: the same name, or `account` starts with `prefix:`. */
export function isPrefix(prefix, account) {
  return account === prefix || account.startsWith(`${prefix}:`);
}

/** The root (first part) of an account name. */
export function rootOf(account) {
  return account.split(':')[0];
}

/** An account name cut to its first `depth` parts. */
export function cutAccount(account, depth) {
  return account.split(':').slice(0, depth).join(':');
}

/** Text compared by character code: the order ledge sorts account names, currencies and periods in. */
export function compareText(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Whether a line holds only whitespace (spaces and tabs). */
export function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

/** A text without the spaces and tabs at its ends (only those: other characters are kept). */
export function trimWhitespace(text) {
  return text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The fields of a line, split on runs of spaces and tabs, with none empty. */
export function fieldsOf(line) {
  const trimmed = trimWhitespace(line);
  return trimmed === '' ? [] : trimmed.split(/[ \t]+/);
}

/** Text with `A`–`Z` made small, every other character kept: the case ledge ignores when it compares payees. */
export function foldCase(text) {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Today's date from the computer's local clock, written `YYYY-MM-DD`. */
export function localToday(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
