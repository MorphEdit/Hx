// Importing a bank's CSV file into one account.
//
// The CSV's header names the columns date, payee, amount and currency (in any order; others ignored). Every other row
// is a bank line, its amount the change of the bank account. The rules file maps payee text to the other account; with
// no matching rule the other account is --default, or Expenses:Unknown. Duplicates (a transaction on the same date with
// the same payee and a posting to the bank account of the same amount and currency) are skipped, checked against the
// journal with the rows imported before them. Every account used must be declared.
import { isAmount, negate, parseAmount } from './amount.js';
import { CommandError, InputError } from './errors.js';
import { CsvError, readCsvRows } from './csv.js';
import { splitLines } from './journal.js';
import { fieldsOf, foldCase, isAccount, isBlank, isDate, trimWhitespace, isCurrency } from './names.js';

export const COLUMNS = ['date', 'payee', 'amount', 'currency'];
export const DEFAULT_OTHER = 'Expenses:Unknown';

/** The bank lines of a CSV text named `name`: [{ line, date, payee, amount, currency }]. Throws an InputError. */
export function parseBankCsv(text, name) {
  let rows;
  try {
    rows = readCsvRows(text);
  } catch (e) {
    if (e instanceof CsvError) {
      throw new InputError(name, e.line, e.what);
    }
    throw e;
  }
  if (rows.length === 0) {
    throw new InputError(name, 1, 'the file has no header row');
  }
  const header = rows[0].fields.map(trimWhitespace);
  const column = {};
  for (const want of COLUMNS) {
    const at = header.indexOf(want);
    if (at < 0) {
      throw new InputError(name, rows[0].line, `the header has no ${want} column`);
    }
    column[want] = at;
  }
  const lines = [];
  for (const row of rows.slice(1)) {
    const fail = (what) => {
      throw new InputError(name, row.line, what);
    };
    if (row.fields.length !== header.length) {
      fail(`the row has ${row.fields.length} fields, the header ${header.length}`);
    }
    const value = (key) => trimWhitespace(row.fields[column[key]]);
    const date = value('date');
    const payee = value('payee');
    const amount = value('amount');
    const currency = value('currency');
    if (!isDate(date)) {
      fail(`not a real date: ${date}`);
    }
    if (payee === '') {
      fail('the payee is empty');
    }
    if (/[\r\n]/.test(payee)) {
      fail('the payee holds a line break');
    }
    if (!isAmount(amount)) {
      fail(`not an amount: ${amount}`);
    }
    if (!isCurrency(currency)) {
      fail(`not a currency: ${currency}`);
    }
    lines.push({ line: row.line, date, payee, amount: parseAmount(amount), currency });
  }
  return lines;
}

/** The rules of a rules file's text named `name`: [{ account, text }] in file order. Throws an InputError. */
export function parseRules(text, name) {
  const rules = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || /^[ \t]*#/.test(line)) {
      continue;
    }
    const [account] = fieldsOf(line);
    const rest = trimWhitespace(trimWhitespace(line).slice(account.length));
    if (!isAccount(account)) {
      throw new InputError(name, i + 1, `not an account name: ${account}`);
    }
    if (rest === '') {
      throw new InputError(name, i + 1, 'a rule is an account and the text to look for');
    }
    rules.push({ account, text: rest });
  }
  return rules;
}

/** The other account of a payee: the first rule whose text it contains (A–Z case ignored), else the fallback. */
export function otherAccount(payee, rules, fallback) {
  const folded = foldCase(payee);
  const rule = rules.find((r) => folded.includes(foldCase(r.text)));
  return rule ? rule.account : fallback;
}

/** Whether a transaction already records this bank line in `account`. */
function records(transaction, account, line) {
  return transaction.date === line.date && transaction.payee === line.payee
    && transaction.postings.some((p) => p.account === account && p.amount === line.amount && p.currency === line.currency);
}

/**
 * The transactions an import adds: { added: [transaction], skipped } for the bank lines, the rules, the bank account and
 * the fallback other account. Throws a CommandError (exit 5) for an account that is not declared.
 */
export function planImport(journal, lines, rules, account, fallback = DEFAULT_OTHER) {
  const added = [];
  let skipped = 0;
  for (const line of lines) {
    const known = [...journal.transactions, ...added];
    if (known.some((t) => records(t, account, line))) {
      skipped += 1;
      continue;
    }
    const other = otherAccount(line.payee, rules, fallback);
    added.push({
      line: 0,
      date: line.date,
      payee: line.payee,
      postings: [
        { account, amount: line.amount, currency: line.currency },
        { account: other, amount: negate(line.amount), currency: line.currency },
      ],
    });
  }
  const declared = new Set(journal.accounts);
  const used = [account, ...added.map((t) => t.postings[1].account)];
  const missing = used.find((name) => !declared.has(name));
  if (missing !== undefined) {
    throw new CommandError(`account ${missing} is not declared`);
  }
  return { added, skipped };
}
