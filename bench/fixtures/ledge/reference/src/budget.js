// The budget: monthly limits per account and currency, from a budget file, checked against a month's spending.
//
// The budget file has one limit per line, `<account> <amount> <currency>`; blank lines and comment lines (`#`) are
// skipped. A limit is more than 0.00; the account need not be declared. A wrong line, or a second line for the same
// account and currency, is an error (exit 4) naming the file and `line N`.
import { isAmount, parseAmount, roundHalfUp } from './amount.js';
import { InputError } from './errors.js';
import { splitLines } from './journal.js';
import { compareText, fieldsOf, isAccount, isBlank, isCurrency, isPrefix } from './names.js';

/** The limits of a budget file's text, named `name` in errors: [{ line, account, amount, currency }] in file order. */
export function parseBudget(text, name) {
  const limits = [];
  const seen = new Set();
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (isBlank(line) || /^[ \t]*#/.test(line)) {
      continue;
    }
    const fail = (what) => {
      throw new InputError(name, n, what);
    };
    const fields = fieldsOf(line);
    if (fields.length !== 3) {
      fail('a budget line is an account, an amount and a currency');
    }
    const [account, amount, currency] = fields;
    if (!isAccount(account)) {
      fail(`not an account name: ${account}`);
    }
    if (!isAmount(amount)) {
      fail(`not an amount: ${amount}`);
    }
    if (!isCurrency(currency)) {
      fail(`not a currency: ${currency}`);
    }
    const cents = parseAmount(amount);
    if (cents <= 0) {
      fail('a limit must be more than 0.00');
    }
    const key = `${account}\u0000${currency}`;
    if (seen.has(key)) {
      fail(`a second limit for ${account} in ${currency}`);
    }
    seen.add(key);
    limits.push({ line: n, account, amount: cents, currency });
  }
  return limits;
}

/**
 * Each limit against the month's spending, sorted by account then currency:
 * [{ account, currency, spent, limit, percent, left, over }] — `left` (limit minus spent) when spent is not more than
 * the limit, else `over` (spent minus limit); the other is null. Spent is the sum of the month's postings, in that
 * currency, to the account and every account it is a prefix of.
 */
export function checkBudget(journal, month, limits) {
  const rows = [];
  for (const limit of [...limits].sort((a, b) => compareText(a.account, b.account) || compareText(a.currency, b.currency))) {
    let spent = 0;
    for (const transaction of journal.transactions) {
      if (transaction.date.slice(0, 7) !== month) {
        continue;
      }
      for (const posting of transaction.postings) {
        if (posting.currency === limit.currency && isPrefix(limit.account, posting.account)) {
          spent += posting.amount;
        }
      }
    }
    const over = spent > limit.amount;
    rows.push({
      account: limit.account,
      currency: limit.currency,
      spent,
      limit: limit.amount,
      percent: roundHalfUp(spent * 100, limit.amount),
      left: over ? null : limit.amount - spent,
      over: over ? spent - limit.amount : null,
    });
  }
  return rows;
}
