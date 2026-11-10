// The filters, and the order postings are listed in.
//
// A posting is selected when every filter given holds for it:
//   account  — a list of names; one of them is a prefix of the posting's account
//   from, to — its transaction's date is on or after `from`, on or before `to`
//   payee    — its transaction's payee contains the text, ignoring the case of A–Z
//   currency — its currency is that one
import { compareText, foldCase, isPrefix } from './names.js';

/** The filters of an options object, with every one not given left out. */
export function filtersOf(options = {}) {
  const accounts = Array.isArray(options.account)
    ? options.account
    : typeof options.account === 'string'
      ? [options.account]
      : [];
  return {
    accounts,
    from: options.from ?? null,
    to: options.to ?? null,
    payee: options.payee ?? null,
    currency: options.currency ?? null,
  };
}

/** A test `(transaction, posting) => boolean` for the filters of `options`. */
export function selector(options = {}) {
  const f = filtersOf(options);
  const payee = f.payee === null ? null : foldCase(f.payee);
  return (transaction, posting) => {
    if (f.accounts.length > 0 && !f.accounts.some((name) => isPrefix(name, posting.account))) {
      return false;
    }
    if (f.from !== null && compareText(transaction.date, f.from) < 0) {
      return false;
    }
    if (f.to !== null && compareText(transaction.date, f.to) > 0) {
      return false;
    }
    if (payee !== null && !foldCase(transaction.payee).includes(payee)) {
      return false;
    }
    if (f.currency !== null && posting.currency !== f.currency) {
      return false;
    }
    return true;
  };
}

/**
 * The journal's transactions in date order: by date, then reading order. Each is { transaction, index }, index its
 * place in reading order.
 */
export function transactionsByDate(journal) {
  return journal.transactions
    .map((transaction, index) => ({ transaction, index }))
    .sort((a, b) => compareText(a.transaction.date, b.transaction.date) || a.index - b.index);
}

/**
 * The selected postings in date order: by date, then reading order, then the posting's place in its transaction.
 * Each is { transaction, posting }.
 */
export function selectedPostings(journal, options = {}) {
  const test = selector(options);
  const out = [];
  for (const { transaction } of transactionsByDate(journal)) {
    for (const posting of transaction.postings) {
      if (test(transaction, posting)) {
        out.push({ transaction, posting });
      }
    }
  }
  return out;
}

/** The transactions with at least one selected posting, in date order, then reading order. */
export function selectedTransactions(journal, options = {}) {
  const test = selector(options);
  return transactionsByDate(journal)
    .map(({ transaction }) => transaction)
    .filter((transaction) => transaction.postings.some((posting) => test(transaction, posting)));
}
