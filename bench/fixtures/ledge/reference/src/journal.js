// The journal parser. A journal is read line by line, top to bottom, with every `include` read in place of its line.
// Each line is checked when it is read; a transaction's own checks (at least two postings, at most one posting
// without an amount, the inferred currency, the balance) are made when it ends, and reported at its date line. So the
// first error in reading order is always the one reported.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAmount, parseAmount, negate } from './amount.js';
import { JournalError } from './errors.js';
import { compareText, fieldsOf, isAccount, isBlank, isCurrency, isDate, trimWhitespace } from './names.js';

const DATE_LINE = /^(\d{4}-\d{2}-\d{2})([ \t].*)?$/;
const ACCOUNT_LINE = /^account([ \t].*)?$/;
const INCLUDE_LINE = /^include([ \t].*)?$/;

/** An empty journal: no account, no transaction. */
export function emptyJournal() {
  return { accounts: [], transactions: [] };
}

/** The lines of a text, each without its line ending (LF or CRLF). A final line ending starts no extra line. */
export function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Whether a line is a comment: its first non-whitespace character is `#` or `;`. */
export function isComment(line) {
  return /^[ \t]*[#;]/.test(line);
}

/** The state of one read: what has been declared and found so far, and the transaction that is still open. */
function newState({ follow }) {
  return {
    follow,
    accounts: [],
    declared: new Set(),
    transactions: [],
    open: null,
    // the absolute paths of the files being read, outermost first, to find include cycles
    stack: [],
  };
}

/** A key for a file path that is the same for two spellings of one file. */
function fileKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The checks of a transaction that has ended: at least two postings, at most one without an amount, the missing
 * amount's currency, and a balance of zero in every currency. On success the transaction (with its missing amount
 * filled in) is added to the state's list.
 */
function closeTransaction(state) {
  const open = state.open;
  if (!open) {
    return;
  }
  state.open = null;
  const fail = (what) => {
    throw new JournalError(open.file, open.line, what);
  };
  if (open.postings.length < 2) {
    fail('a transaction needs at least two postings');
  }
  const missing = open.postings.filter((p) => p.amount === null);
  if (missing.length > 1) {
    fail('more than one posting has no amount');
  }
  const totals = new Map();
  for (const p of open.postings) {
    if (p.amount === null) {
      continue;
    }
    totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.amount);
  }
  if (missing.length === 1) {
    if (totals.size !== 1) {
      fail('cannot infer the missing amount: the other postings use more than one currency');
    }
    const [[currency, total]] = [...totals];
    missing[0].amount = negate(total);
    missing[0].currency = currency;
    totals.set(currency, 0);
  }
  const unbalanced = [...totals.keys()].sort(compareText).find((currency) => totals.get(currency) !== 0);
  if (unbalanced !== undefined) {
    fail(`transaction does not balance in ${unbalanced}`);
  }
  state.transactions.push({
    line: open.line,
    date: open.date,
    payee: open.payee,
    postings: open.postings.map((p) => ({ account: p.account, amount: p.amount, currency: p.currency })),
  });
}

/** Reads one posting line of the open transaction. */
function readPosting(state, line, file, n) {
  const fields = fieldsOf(line);
  const fail = (what) => {
    throw new JournalError(file, n, what);
  };
  if (fields.length !== 1 && fields.length !== 3) {
    fail('a posting is an account, then an amount and a currency or nothing');
  }
  const [account, amount, currency] = fields;
  if (!isAccount(account)) {
    fail(`not an account name: ${account}`);
  }
  if (!state.declared.has(account)) {
    fail(`account ${account} is not declared`);
  }
  if (fields.length === 1) {
    state.open.postings.push({ account, amount: null, currency: null });
    return;
  }
  if (!isAmount(amount)) {
    fail(`not an amount: ${amount}`);
  }
  if (!isCurrency(currency)) {
    fail(`not a currency: ${currency}`);
  }
  state.open.postings.push({ account, amount: parseAmount(amount), currency });
}

/** Reads an `account` line. */
function readAccount(state, line, file, n) {
  const fields = fieldsOf(line);
  if (fields.length !== 2) {
    throw new JournalError(file, n, 'an account line is `account` and one account name');
  }
  const name = fields[1];
  if (!isAccount(name)) {
    throw new JournalError(file, n, `not an account name: ${name}`);
  }
  if (state.declared.has(name)) {
    throw new JournalError(file, n, `account ${name} is declared twice`);
  }
  state.declared.add(name);
  state.accounts.push(name);
}

/** Reads an `include` line: the other file's lines, in place of this one. */
function readInclude(state, line, file, n, dir) {
  const target = trimWhitespace(line.slice('include'.length));
  if (target === '') {
    throw new JournalError(file, n, 'an include line names a file');
  }
  if (!state.follow) {
    throw new JournalError(file, n, 'include is not followed here: there is no file to read it from');
  }
  const full = path.resolve(dir, target);
  const shown = path.join(path.dirname(file), target);
  if (state.stack.includes(fileKey(full))) {
    throw new JournalError(file, n, `include cycle: ${target} is already being read`);
  }
  let text;
  try {
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw new Error('no such file');
    }
    text = readFileSync(full, 'utf8');
  } catch {
    throw new JournalError(file, n, `cannot read the included file ${target}`);
  }
  readText(state, text, shown, full);
}

/** Reads a date line: the start of a transaction. */
function readDateLine(state, match, file, n) {
  const [, date, rest] = match;
  if (!isDate(date)) {
    throw new JournalError(file, n, `not a real date: ${date}`);
  }
  const payee = trimWhitespace(rest ?? '');
  if (payee === '') {
    throw new JournalError(file, n, 'a transaction needs a payee');
  }
  state.open = { line: n, date, payee, file, postings: [] };
}

/** Reads every line of one text. `file` is its name in messages; `full` its absolute path (null: no file). */
function readText(state, text, file, full) {
  const dir = full ? path.dirname(full) : process.cwd();
  if (full) {
    state.stack.push(fileKey(full));
  }
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (isBlank(line)) {
      closeTransaction(state);
      continue;
    }
    if (isComment(line)) {
      continue;
    }
    if (/^[ \t]/.test(line)) {
      if (!state.open) {
        throw new JournalError(file, n, 'a posting outside a transaction');
      }
      readPosting(state, line, file, n);
      continue;
    }
    // any other line ends the open transaction first: its checks come before this line's
    closeTransaction(state);
    if (ACCOUNT_LINE.test(line)) {
      readAccount(state, line, file, n);
      continue;
    }
    if (INCLUDE_LINE.test(line)) {
      readInclude(state, line, file, n, dir);
      continue;
    }
    const date = DATE_LINE.exec(line);
    if (date) {
      readDateLine(state, date, file, n);
      continue;
    }
    throw new JournalError(file, n, 'not a transaction, an account, an include or a comment');
  }
  // a transaction ends at the end of its file
  closeTransaction(state);
  if (full) {
    state.stack.pop();
  }
}

/**
 * One journal text, named `name` in error messages. `include` is not followed: an include line is an error.
 * → { accounts, transactions }. Throws a JournalError (an Error with `line`) at the first error.
 */
export function parseJournal(text, name = 'journal') {
  if (typeof text !== 'string') {
    throw new TypeError('parseJournal takes the journal text');
  }
  const state = newState({ follow: false });
  readText(state, text, name, null);
  return { accounts: state.accounts, transactions: state.transactions };
}

/**
 * A journal file, following its includes. A file that does not exist is an empty journal. `name` is the file's name
 * in error messages (the path as given by default).
 */
export function loadJournal(file, name = file) {
  if (!existsSync(file)) {
    return emptyJournal();
  }
  const text = readFileSync(file, 'utf8');
  const state = newState({ follow: true });
  readText(state, text, name, path.resolve(file));
  return { accounts: state.accounts, transactions: state.transactions };
}
