// The command line: `run(argv, env)` → { code, stdout, stderr }. The checks run in the order of the brief's list, so
// when several things are wrong the first in the list wins:
//   1 the command line (usage, exit 1) — nothing is read before it is checked;
//   2 the environment (exit 2): LEDGE_TODAY, then the files named on the command line or the budget file;
//   3 the journal (exit 3);
//   4 the other input files' content (exit 4): the CSV, then the rules, or the budget file;
//   5 the command's own checks (exit 5).
// Output goes to stdout, every line ending with `\n`; an error goes to stderr only, stdout stays empty and no file is
// changed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatAmount, negate } from './amount.js';
import { parseArgs } from './args.js';
import { checkBudget, parseBudget } from './budget.js';
import { toCsv } from './csv.js';
import { CommandError, EnvironmentError, EXIT, LedgeError } from './errors.js';
import { DEFAULT_OTHER, parseBankCsv, parseRules, planImport } from './importer.js';
import { loadJournal } from './journal.js';
import { compareText, isDate, localToday } from './names.js';
import { balance, register, report } from './queries.js';
import { selectedPostings, selectedTransactions } from './select.js';
import { appendToJournal, transactionLines } from './writer.js';

export const DEFAULT_JOURNAL = 'ledger.journal';
export const DEFAULT_BUDGET = 'ledge.budget';

/** Today: LEDGE_TODAY when set (it must be a real date), else the local clock. */
export function today(env) {
  const value = env.LEDGE_TODAY;
  if (value === undefined || value === '') {
    return localToday();
  }
  if (!isDate(value)) {
    throw new EnvironmentError(`LEDGE_TODAY is not a real date (YYYY-MM-DD): ${value}`);
  }
  return value;
}

/** The journal's path: LEDGE_FILE, else ledger.journal in the current folder. */
export function journalPath(env) {
  return env.LEDGE_FILE ? env.LEDGE_FILE : DEFAULT_JOURNAL;
}

/** A file named on the command line, read: an EnvironmentError (exit 2) when it does not exist or cannot be read. */
function readInputFile(file, what) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error('no such file');
    }
    return readFileSync(file, 'utf8');
  } catch {
    throw new EnvironmentError(`cannot read the ${what} ${file}`);
  }
}

/** The filters and query options of the parsed command line. */
function queryOptions(args) {
  const out = {};
  for (const key of ['account', 'from', 'to', 'payee', 'currency', 'depth', 'sort']) {
    if (args[key] !== undefined) {
      out[key] = args[key];
    }
  }
  return out;
}

/** `ok: N transactions, M accounts` */
function check(journal) {
  return [`ok: ${journal.transactions.length} transactions, ${journal.accounts.length} accounts`];
}

/** The declared accounts, sorted. */
function accounts(journal) {
  return [...journal.accounts].sort(compareText);
}

/** `account <name>`: declared unless it already is. */
function declare(journal, file, name) {
  if (journal.accounts.includes(name)) {
    throw new CommandError(`account ${name} is already declared`);
  }
  appendToJournal(file, [{ kind: 'account', name }]);
  return [`declared ${name}`];
}

/** `add`: the transaction checked against the journal, then written with its inferred amount. */
function add(journal, file, args, date) {
  const declared = new Set(journal.accounts);
  const undeclared = args.postings.find((p) => !declared.has(p.account));
  if (undeclared) {
    throw new CommandError(`account ${undeclared.account} is not declared`);
  }
  const missing = args.postings.filter((p) => p.amount === null);
  if (missing.length > 1) {
    throw new CommandError('more than one posting has no amount');
  }
  const totals = new Map();
  for (const p of args.postings) {
    if (p.amount !== null) {
      totals.set(p.currency, (totals.get(p.currency) ?? 0) + p.amount);
    }
  }
  const postings = args.postings.map((p) => ({ ...p }));
  if (missing.length === 1) {
    if (totals.size !== 1) {
      throw new CommandError('cannot infer the missing amount: the other postings use more than one currency');
    }
    const [[currency, total]] = [...totals];
    const blank = postings.find((p) => p.amount === null);
    blank.amount = negate(total);
    blank.currency = currency;
    totals.set(currency, 0);
  }
  const unbalanced = [...totals.keys()].sort(compareText).find((c) => totals.get(c) !== 0);
  if (unbalanced !== undefined) {
    throw new CommandError(`the transaction does not balance in ${unbalanced}`);
  }
  const transaction = { line: 0, date, payee: args.payee, postings };
  appendToJournal(file, [{ kind: 'transaction', transaction }]);
  return [`added ${date} ${args.payee}`];
}

/** `balance`: one line per account and currency, then the totals (or `total 0.00`). */
function balanceLines(journal, args) {
  const { rows, totals } = balance(journal, queryOptions(args));
  if (rows.length === 0) {
    return ['total 0.00'];
  }
  return [
    ...rows.map((r) => `${r.account} ${formatAmount(r.amount)} ${r.currency}`),
    ...totals.map((t) => `total ${formatAmount(t.amount)} ${t.currency}`),
  ];
}

/** `register`: one line per selected posting with its running total. */
function registerLines(journal, args) {
  return register(journal, queryOptions(args)).map((e) => `${e.date} ${e.payee}  ${e.account}  `
    + `${formatAmount(e.amount)} ${e.currency}  ${formatAmount(e.running)} ${e.currency}`);
}

/** `report`: per period and currency, then the totals (or the zero total). */
function reportLines(journal, args) {
  const { rows, totals } = report(journal, args.period, queryOptions(args));
  const figures = (r) => `income ${formatAmount(r.income)} ${r.currency} expenses ${formatAmount(r.expenses)} ${r.currency} `
    + `net ${formatAmount(r.net)} ${r.currency}`;
  if (rows.length === 0) {
    return ['total income 0.00 expenses 0.00 net 0.00'];
  }
  return [...rows.map((r) => `${r.period} ${figures(r)}`), ...totals.map((t) => `total ${figures(t)}`)];
}

/** `print`: the selected transactions as ledge writes them, a blank line between them. */
function printLines(journal, args) {
  const out = [];
  for (const transaction of selectedTransactions(journal, queryOptions(args))) {
    if (out.length > 0) {
      out.push('');
    }
    out.push(...transactionLines(transaction));
  }
  return out;
}

/** `export`: the selected postings as CSV, in date order. */
function exportText(journal, args) {
  const rows = [['date', 'payee', 'account', 'amount', 'currency']];
  for (const { transaction, posting } of selectedPostings(journal, queryOptions(args))) {
    rows.push([transaction.date, transaction.payee, posting.account, formatAmount(posting.amount), posting.currency]);
  }
  return toCsv(rows);
}

/** `budget`: one line per limit. */
function budgetLines(journal, limits, month) {
  return checkBudget(journal, month, limits).map((r) => {
    const head = `${r.account} ${formatAmount(r.spent)} of ${formatAmount(r.limit)} ${r.currency} ${r.percent}%`;
    return r.over === null ? `${head} left ${formatAmount(r.left)}` : `${head} over ${formatAmount(r.over)}`;
  });
}

/** Runs one command line. Never throws for a LedgeError: it becomes the exit code and the message. */
export function run(argv, env = process.env) {
  try {
    const args = parseArgs(argv);
    // 2. the environment
    const now = today(env);
    const file = journalPath(env);
    let csvText = null;
    let rulesText = null;
    let budgetText = null;
    let budgetFile = null;
    if (args.command === 'import') {
      csvText = readInputFile(args.csvFile, 'CSV file');
      if (args.rulesFile !== null) {
        rulesText = readInputFile(args.rulesFile, 'rules file');
      }
    }
    if (args.command === 'budget') {
      budgetFile = args.budgetFile ?? path.join(path.dirname(file), DEFAULT_BUDGET);
      budgetText = readInputFile(budgetFile, 'budget file');
    }
    // 3. the journal
    const journal = loadJournal(file);
    // 4 and 5: the command, with its input files and its own checks
    let out;
    switch (args.command) {
      case 'check':
        out = check(journal);
        break;
      case 'accounts':
        out = accounts(journal);
        break;
      case 'account':
        out = declare(journal, file, args.name);
        break;
      case 'add':
        out = add(journal, file, args, args.date === 'today' ? now : args.date);
        break;
      case 'balance':
        out = balanceLines(journal, args);
        break;
      case 'register':
        out = registerLines(journal, args);
        break;
      case 'report':
        out = reportLines(journal, args);
        break;
      case 'print':
        out = printLines(journal, args);
        break;
      case 'export':
        return { code: EXIT.ok, stdout: exportText(journal, args), stderr: '' };
      case 'budget': {
        const limits = parseBudget(budgetText, budgetFile);
        out = budgetLines(journal, limits, args.month ?? now.slice(0, 7));
        break;
      }
      case 'import': {
        const lines = parseBankCsv(csvText, args.csvFile);
        const rules = rulesText === null ? [] : parseRules(rulesText, args.rulesFile);
        const { added, skipped } = planImport(journal, lines, rules, args.account, args.fallback ?? DEFAULT_OTHER);
        appendToJournal(file, added.map((transaction) => ({ kind: 'transaction', transaction })));
        out = [`imported ${added.length}, skipped ${skipped}`];
        break;
      }
      default:
        throw new Error(`no such command: ${args.command}`);
    }
    return { code: EXIT.ok, stdout: out.map((line) => `${line}\n`).join(''), stderr: '' };
  } catch (e) {
    if (e instanceof LedgeError) {
      return { code: e.code, stdout: '', stderr: `ledge: ${e.message}\n` };
    }
    return { code: EXIT.usage, stdout: '', stderr: `ledge: unexpected error: ${e?.message ?? e}\n` };
  }
}
