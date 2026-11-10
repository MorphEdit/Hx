// The queries over a journal: balance, register and the income and expense report. Each returns plain data in the
// order it is printed; src/cli.js turns that data into lines.
import { negate } from './amount.js';
import { compareText, cutAccount, rootOf } from './names.js';
import { selectedPostings } from './select.js';

/** Sums by key: a Map from key to { ...fields, amount }, in the order the keys were first seen. */
function addUp(entries, keyOf, fieldsOf) {
  const sums = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!sums.has(key)) {
      sums.set(key, { ...fieldsOf(entry), amount: 0 });
    }
    sums.get(key).amount += entry.posting.amount;
  }
  return sums;
}

/** One total per currency of a list of { currency, amount }, sorted by currency. */
export function totalsByCurrency(rows) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  }
  return [...totals.keys()].sort(compareText).map((currency) => ({ currency, amount: totals.get(currency) }));
}

/**
 * The balance of the selected postings: one row per account and currency (accounts cut to `depth` parts first),
 * sorted by account then currency, or with `sort: 'amount'` by currency, amount from largest to smallest, then account.
 * Then one total per currency. → { rows: [{ account, currency, amount }], totals: [{ currency, amount }] }
 */
export function balance(journal, options = {}) {
  const depth = options.depth ?? null;
  const name = (account) => (depth === null ? account : cutAccount(account, depth));
  const sums = addUp(
    selectedPostings(journal, options),
    ({ posting }) => `${name(posting.account)}\u0000${posting.currency}`,
    ({ posting }) => ({ account: name(posting.account), currency: posting.currency }),
  );
  const rows = [...sums.values()];
  if (options.sort === 'amount') {
    rows.sort((a, b) => compareText(a.currency, b.currency) || b.amount - a.amount || compareText(a.account, b.account));
  } else {
    rows.sort((a, b) => compareText(a.account, b.account) || compareText(a.currency, b.currency));
  }
  return { rows, totals: totalsByCurrency(rows) };
}

/**
 * The register: one entry per selected posting, in date order (date, reading order, place in the transaction), or with
 * `sort: 'amount'` by amount from largest to smallest with ties in date order. `running` is the sum of the entries so
 * far in that currency, this one included.
 * → [{ date, payee, account, amount, currency, running }]
 */
export function register(journal, options = {}) {
  const entries = selectedPostings(journal, options).map(({ transaction, posting }, order) => ({
    order,
    date: transaction.date,
    payee: transaction.payee,
    account: posting.account,
    amount: posting.amount,
    currency: posting.currency,
  }));
  if (options.sort === 'amount') {
    entries.sort((a, b) => b.amount - a.amount || a.order - b.order);
  }
  const running = new Map();
  return entries.map(({ order, ...entry }) => {
    const total = (running.get(entry.currency) ?? 0) + entry.amount;
    running.set(entry.currency, total);
    return { ...entry, running: total };
  });
}

/** The period of a date: `2024-03` (month), `2024-Q1` (quarter) or `2024` (year). */
export function periodOf(date, period) {
  const year = date.slice(0, 4);
  const month = Number(date.slice(5, 7));
  if (period === 'month') {
    return date.slice(0, 7);
  }
  if (period === 'quarter') {
    return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  }
  if (period === 'year') {
    return year;
  }
  throw new Error(`not a period: ${period}`);
}

/** Income, expenses and net from the sums of the Income and Expenses postings. */
function figures(incomeSum, expenseSum) {
  const income = negate(incomeSum);
  return { income, expenses: expenseSum, net: income - expenseSum };
}

/**
 * The income and expense report: the selected postings to Income and Expenses accounts added up per period and
 * currency. Income is the Income postings' sum with its sign turned over, net is income minus expenses.
 * → { rows: [{ period, currency, income, expenses, net }], totals: [{ currency, income, expenses, net }] }
 */
export function report(journal, period, options = {}) {
  const cells = new Map();
  const totals = new Map();
  const add = (map, key, fields, root, amount) => {
    if (!map.has(key)) {
      map.set(key, { ...fields, incomeSum: 0, expenseSum: 0 });
    }
    const cell = map.get(key);
    if (root === 'Income') {
      cell.incomeSum += amount;
    } else {
      cell.expenseSum += amount;
    }
  };
  for (const { transaction, posting } of selectedPostings(journal, options)) {
    const root = rootOf(posting.account);
    if (root !== 'Income' && root !== 'Expenses') {
      continue;
    }
    const p = periodOf(transaction.date, period);
    add(cells, `${p}\u0000${posting.currency}`, { period: p, currency: posting.currency }, root, posting.amount);
    add(totals, posting.currency, { currency: posting.currency }, root, posting.amount);
  }
  const rows = [...cells.values()]
    .sort((a, b) => compareText(a.period, b.period) || compareText(a.currency, b.currency))
    .map((c) => ({ period: c.period, currency: c.currency, ...figures(c.incomeSum, c.expenseSum) }));
  const sums = [...totals.values()]
    .sort((a, b) => compareText(a.currency, b.currency))
    .map((c) => ({ currency: c.currency, ...figures(c.incomeSum, c.expenseSum) }));
  return { rows, totals: sums };
}
