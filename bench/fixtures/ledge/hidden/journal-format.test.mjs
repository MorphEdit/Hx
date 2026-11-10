// The journal format as the brief gives it: what reads fine, and what reading it gives.
import { describe, test } from 'node:test';
import { ledge, lines, ok, workdir } from './helpers.mjs';

const head = ['account Assets:Bank', 'account Expenses:Food', 'account Income:Salary'];

describe('the journal format', { concurrency: true }, () => {
  test('check counts transactions and accounts', async () => {
    const journal = lines(...head, '', '2024-01-05 Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD');
    ok(await ledge(['check'], { journal }), 'ok: 1 transactions, 3 accounts');
  });

  test('a journal that does not exist is empty', async () => {
    ok(await ledge(['check']), 'ok: 0 transactions, 0 accounts');
  });

  test('an empty journal file is empty', async () => {
    ok(await ledge(['check'], { journal: '' }), 'ok: 0 transactions, 0 accounts');
  });

  test('without LEDGE_FILE the journal is ledger.journal in the current folder', async () => {
    const dir = workdir({ 'ledger.journal': lines('account Assets:Bank') });
    ok(await ledge(['check'], { dir, file: null }), 'ok: 0 transactions, 1 accounts');
  });

  test('LEDGE_FILE names the journal', async () => {
    const dir = workdir({ 'books/mine.txt': lines('account Assets:Bank', 'account Assets:Cash') });
    ok(await ledge(['check'], { dir, file: 'books/mine.txt' }), 'ok: 0 transactions, 2 accounts');
  });

  test('comment lines with # and ; are ignored, also between postings', async () => {
    const journal = lines('# my books', ...head, '; a note', '2024-01-05 Shop', '    # the food', '    Expenses:Food  42.10 USD',
      '  ; and the bank', '    Assets:Bank  -42.10 USD');
    ok(await ledge(['balance'], { journal }), 'Assets:Bank -42.10 USD', 'Expenses:Food 42.10 USD', 'total 0.00 USD');
  });

  test('blank lines holding only whitespace are blank', async () => {
    const journal = lines(...head, '   \t', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -1.00 USD', ' ');
    ok(await ledge(['check'], { journal }), 'ok: 1 transactions, 3 accounts');
  });

  test('CRLF line endings read fine', async () => {
    const journal = [...head, '', '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank  -1.00 USD'].join('\r\n') + '\r\n';
    ok(await ledge(['balance'], { journal }), 'Assets:Bank -1.00 USD', 'Expenses:Food 1.00 USD', 'total 0.00 USD');
  });

  test('tabs and runs of spaces separate the fields, and trailing whitespace is fine', async () => {
    const journal = lines('account\tAssets:Bank  ', 'account   Expenses:Food', '', '2024-01-05\tShop  \t',
      '\tExpenses:Food\t\t1.00   USD ', '  Assets:Bank \t -1.00\tUSD');
    ok(await ledge(['register'], { journal }), '2024-01-05 Shop  Expenses:Food  1.00 USD  1.00 USD',
      '2024-01-05 Shop  Assets:Bank  -1.00 USD  0.00 USD');
  });

  test('the payee is the rest of the date line, inner spaces kept', async () => {
    const journal = lines(...head, '2024-01-05   The  Corner, Shop #2  ', '    Expenses:Food  1.00 USD', '    Assets:Bank  -1.00 USD');
    ok(await ledge(['register', '--account', 'Assets'], { journal }), '2024-01-05 The  Corner, Shop #2  Assets:Bank  -1.00 USD  -1.00 USD');
  });

  test('a posting without an amount gets the amount that balances', async () => {
    const journal = lines(...head, '2024-01-31 ACME', '    Assets:Bank  3000.00 USD', '    Income:Salary');
    ok(await ledge(['balance'], { journal }), 'Assets:Bank 3000.00 USD', 'Income:Salary -3000.00 USD', 'total 0.00 USD');
  });

  test('the posting without an amount may come first', async () => {
    const journal = lines(...head, '2024-01-31 ACME', '    Income:Salary', '    Assets:Bank  1500.25 USD', '    Assets:Bank  1500.00 USD');
    ok(await ledge(['balance', '--account', 'Income'], { journal }), 'Income:Salary -3000.25 USD', 'total -3000.25 USD');
  });

  test('a transaction may balance in two currencies at once', async () => {
    const journal = lines(...head, '2024-01-05 Trip', '    Expenses:Food  10.00 USD', '    Assets:Bank  -10.00 USD',
      '    Expenses:Food  20.00 EUR', '    Assets:Bank  -20.00 EUR');
    ok(await ledge(['balance'], { journal }), 'Assets:Bank -20.00 EUR', 'Assets:Bank -10.00 USD', 'Expenses:Food 20.00 EUR',
      'Expenses:Food 10.00 USD', 'total 0.00 EUR', 'total 0.00 USD');
  });

  test('a transaction may post to the same account twice', async () => {
    const journal = lines(...head, '2024-01-05 Shop', '    Expenses:Food  1.00 USD', '    Expenses:Food  2.00 USD', '    Assets:Bank  -3.00 USD');
    ok(await ledge(['balance', '--account', 'Expenses'], { journal }), 'Expenses:Food 3.00 USD', 'total 3.00 USD');
  });

  test('amounts are read in whole cents: leading zeros and -0.00 are fine', async () => {
    const journal = lines(...head, '2024-01-05 Shop', '    Expenses:Food  007.50 USD', '    Assets:Bank  -7.50 USD',
      '    Expenses:Food  -0.00 USD');
    ok(await ledge(['balance'], { journal }), 'Assets:Bank -7.50 USD', 'Expenses:Food 7.50 USD', 'total 0.00 USD');
  });

  test('transactions need not be in date order', async () => {
    const journal = lines(...head, '2024-02-01 Later', '    Expenses:Food  2.00 USD', '    Assets:Bank', '',
      '2024-01-01 Earlier', '    Expenses:Food  1.00 USD', '    Assets:Bank');
    ok(await ledge(['register', '--account', 'Expenses'], { journal }), '2024-01-01 Earlier  Expenses:Food  1.00 USD  1.00 USD',
      '2024-02-01 Later  Expenses:Food  2.00 USD  3.00 USD');
  });

  test('a transaction ends at the next unindented line, with no blank line between', async () => {
    const journal = lines(...head, '2024-01-05 One', '    Expenses:Food  1.00 USD', '    Assets:Bank', '2024-01-06 Two',
      '    Expenses:Food  2.00 USD', '    Assets:Bank', 'account Assets:Cash');
    ok(await ledge(['check'], { journal }), 'ok: 2 transactions, 4 accounts');
  });

  test('a leap day is a real date', async () => {
    const journal = lines(...head, '2024-02-29 Leap', '    Expenses:Food  1.00 USD', '    Assets:Bank');
    ok(await ledge(['check'], { journal }), 'ok: 1 transactions, 3 accounts');
  });

  test('account names may hold digits, - and _, and many parts', async () => {
    const journal = lines('account Assets:Bank-2:Sub_Acct:x9', 'account Equity:Opening', '2024-01-05 Open',
      '    Assets:Bank-2:Sub_Acct:x9  5.00 USD', '    Equity:Opening');
    ok(await ledge(['accounts'], { journal }), 'Assets:Bank-2:Sub_Acct:x9', 'Equity:Opening');
  });

  test('include reads another file in place, relative to the including file', async () => {
    const dir = workdir({
      'books/main.journal': lines(...head, 'include sub/cards.journal', '2024-01-07 Shop', '    Expenses:Food  1.00 USD', '    Assets:Bank'),
      'books/sub/cards.journal': lines('account Liabilities:Card', '2024-01-06 Cafe', '    Expenses:Food  3.00 USD', '    Liabilities:Card'),
    });
    ok(await ledge(['balance'], { dir, file: 'books/main.journal' }), 'Assets:Bank -1.00 USD', 'Expenses:Food 4.00 USD',
      'Liabilities:Card -3.00 USD', 'total 0.00 USD');
  });

  test('an included file may include another, and include paths may hold spaces', async () => {
    const dir = workdir({
      'main.journal': lines(...head, 'include my cards.journal'),
      'my cards.journal': lines('include more/two.journal'),
      'more/two.journal': lines('2024-01-06 Deep', '    Expenses:Food  3.00 USD', '    Assets:Bank'),
    });
    ok(await ledge(['check'], { dir, file: 'main.journal' }), 'ok: 1 transactions, 3 accounts');
  });

  test('accounts declared in an included file count, in reading order', async () => {
    const dir = workdir({
      'main.journal': lines('account Income:Salary', 'include a.journal', 'account Assets:Bank'),
      'a.journal': lines('account Expenses:Food'),
    });
    ok(await ledge(['accounts'], { dir, file: 'main.journal' }), 'Assets:Bank', 'Expenses:Food', 'Income:Salary');
  });

  test('the same file included twice side by side is no cycle', async () => {
    const dir = workdir({
      'main.journal': lines(...head, 'include t.journal', 'include t.journal'),
      't.journal': lines('2024-01-06 Shop', '    Expenses:Food  3.00 USD', '    Assets:Bank'),
    });
    ok(await ledge(['check'], { dir, file: 'main.journal' }), 'ok: 2 transactions, 3 accounts');
  });
});
