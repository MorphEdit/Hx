// How ledge writes the journal. It only ever adds to the end of the file: what is already there is never changed.
// If the file does not end with a line break, one is added first. A transaction is preceded by a blank line, unless
// the file is empty or its last line is already blank; an `account` line is added with no blank line before it.
// Line endings written are LF.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { formatAmount } from './amount.js';
import { CommandError } from './errors.js';
import { isBlank } from './names.js';

/** A transaction's lines as ledge writes them: the date line, then one line per posting, every amount written. */
export function transactionLines(transaction) {
  return [
    `${transaction.date} ${transaction.payee}`,
    ...transaction.postings.map((p) => `    ${p.account}  ${formatAmount(p.amount)} ${p.currency}`),
  ];
}

/** A transaction as text, its lines each ending with `\n`. */
export function formatTransaction(transaction) {
  return transactionLines(transaction).map((line) => `${line}\n`).join('');
}

/** Whether the last line of a text that ends with a line break is blank (an empty text has no last line). */
function endsWithBlankLine(text) {
  if (!text.endsWith('\n')) {
    return false;
  }
  const lines = text.slice(0, -1).split('\n');
  const last = lines[lines.length - 1].replace(/\r$/, '');
  return isBlank(last);
}

/**
 * What to add to a journal whose text is `existing` ('' when there is none) for the blocks, in order: each
 * { kind: 'account', name } or { kind: 'transaction', transaction }. Returns only the added text.
 */
export function additions(existing, blocks) {
  let text = existing;
  let added = '';
  const put = (s) => {
    text += s;
    added += s;
  };
  if (text !== '' && !text.endsWith('\n')) {
    put('\n');
  }
  for (const block of blocks) {
    if (block.kind === 'account') {
      put(`account ${block.name}\n`);
      continue;
    }
    if (text !== '' && !endsWithBlankLine(text)) {
      put('\n');
    }
    put(formatTransaction(block.transaction));
  }
  return added;
}

/** Adds the blocks to the journal file, creating it when it does not exist. */
export function appendToJournal(file, blocks) {
  // the existing bytes are only read to see how the file ends: they are never written back
  const existing = existsSync(file) ? readFileSync(file).toString('latin1') : '';
  const text = additions(existing, blocks);
  try {
    appendFileSync(file, text, 'utf8');
  } catch (e) {
    throw new CommandError(`cannot write the journal: ${e.message}`);
  }
}
