// The library: the functions the brief lists under "Using it from Node".
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BOOK, lines, loadLib, workdir } from './helpers.mjs';

const pick = (t) => ({ line: t.line, date: t.date, payee: t.payee, postings: t.postings.map((p) => ({ account: p.account, amount: p.amount, currency: p.currency })) });

describe('the library', { concurrency: true }, () => {
  test('parseAmount reads whole cents', async () => {
    const lib = await loadLib();
    assert.equal(lib.parseAmount('42.10'), 4210);
    assert.equal(lib.parseAmount('-7.05'), -705);
    assert.equal(lib.parseAmount('007.50'), 750);
    // the brief leaves the sign of a parsed zero open: -0 and 0 both pass
    assert.equal(lib.parseAmount('-0.00') === 0, true);
  });

  test('parseAmount throws for text that is not an amount', async () => {
    const lib = await loadLib();
    for (const bad of ['42.1', '42', '+1.00', '1,000.00', '1.000', '', 'abc', '.50', '1.00 ']) assert.throws(() => lib.parseAmount(bad), Error, bad);
  });

  test('formatAmount prints as ledge prints', async () => {
    const lib = await loadLib();
    assert.deepEqual([4210, -705, 5, 0, -0, 100, 123456789].map(lib.formatAmount), ['42.10', '-7.05', '0.05', '0.00', '0.00', '1.00', '1234567.89']);
  });

  test('parseJournal gives the accounts in reading order and the transactions with their lines', async () => {
    const lib = await loadLib();
    const j = lib.parseJournal(lines('account Income:Salary', 'account Assets:Bank', '', '# pay', '2024-01-31 ACME', '    Assets:Bank  3000.00 USD',
      '    Income:Salary'));
    assert.deepEqual(j.accounts, ['Income:Salary', 'Assets:Bank']);
    assert.deepEqual(j.transactions.map(pick), [{ line: 5, date: '2024-01-31', payee: 'ACME', postings: [
      { account: 'Assets:Bank', amount: 300000, currency: 'USD' }, { account: 'Income:Salary', amount: -300000, currency: 'USD' }] }]);
  });

  test('parseJournal keeps reading order, not date order', async () => {
    const lib = await loadLib();
    const j = lib.parseJournal(BOOK);
    assert.deepEqual(j.transactions.map((t) => t.date), ['2024-01-01', '2024-01-05', '2024-01-31', '2024-02-01', '2024-02-03', '2024-01-20', '2024-04-02']);
  });

  test('parseJournal throws an Error with line N in its message and the line property', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseJournal(lines('account Assets:Bank', '', 'nope')), (e) => e instanceof Error && e.line === 3 && /\bline 3\b/.test(e.message));
  });

  test('parseJournal names the journal in its error message', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseJournal('oops\n', 'mine.journal'), (e) => e.message.includes('mine.journal') && e.line === 1);
  });

  test('parseJournal does not follow include: an include line is an error', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseJournal(lines('account Assets:Bank', 'include other.journal')), (e) => e.line === 2);
  });

  test('loadJournal follows includes; a missing file is an empty journal', async () => {
    const lib = await loadLib();
    const dir = workdir({ 'm.journal': lines('account Assets:Bank', 'include s/x.journal'), 's/x.journal': lines('account Equity:E', '2024-01-01 Open',
      '    Assets:Bank  1.00 USD', '    Equity:E') });
    const j = lib.loadJournal(path.join(dir, 'm.journal'));
    assert.deepEqual(j.accounts, ['Assets:Bank', 'Equity:E']);
    assert.deepEqual(j.transactions.map((t) => [t.date, t.payee, t.postings.length]), [['2024-01-01', 'Open', 2]]);
    const none = lib.loadJournal(path.join(dir, 'nothing.journal'));
    assert.deepEqual([none.accounts, none.transactions], [[], []]);
  });

  test('balance gives the rows and totals in printed order', async () => {
    const lib = await loadLib();
    const b = lib.balance(lib.parseJournal(BOOK), { account: ['Expenses'], depth: 2 });
    assert.deepEqual(b.rows, [{ account: 'Expenses:Food', currency: 'EUR', amount: 450 }, { account: 'Expenses:Food', currency: 'USD', amount: 5210 },
      { account: 'Expenses:Rent', currency: 'USD', amount: 120000 }]);
    assert.deepEqual(b.totals, [{ currency: 'EUR', amount: 450 }, { currency: 'USD', amount: 125210 }]);
  });

  test('balance with no options is every account; with sort amount, by currency then amount', async () => {
    const lib = await loadLib();
    const j = lib.parseJournal(BOOK);
    assert.equal(lib.balance(j).rows.length, 8);
    assert.deepEqual(lib.balance(j, { sort: 'amount', currency: 'USD', from: '2024-02-01' }).rows.map((r) => r.account),
      ['Assets:Bank', 'Expenses:Rent', 'Income:Salary']);
  });

  test('register gives each selected posting with its running total', async () => {
    const lib = await loadLib();
    const r = lib.register(lib.parseJournal(BOOK), { account: ['Assets:Bank'], to: '2024-01-31' });
    assert.deepEqual(r, [
      { date: '2024-01-01', payee: 'Opening balance', account: 'Assets:Bank', amount: 100000, currency: 'USD', running: 100000 },
      { date: '2024-01-05', payee: 'Corner Shop', account: 'Assets:Bank', amount: -4210, currency: 'USD', running: 95790 },
      { date: '2024-01-31', payee: 'ACME Ltd', account: 'Assets:Bank', amount: 300000, currency: 'USD', running: 395790 },
    ]);
  });

  test('register with sort amount and a payee filter', async () => {
    const lib = await loadLib();
    const r = lib.register(lib.parseJournal(BOOK), { payee: 'corner', sort: 'amount' });
    assert.deepEqual(r.map((e) => [e.amount, e.running]), [[4210, 4210], [1000, 5210], [-1000, 4210], [-4210, 0]]);
  });

  test('parseCsv reads quotes, doubled quotes, line breaks in quotes and CRLF; blank lines skipped', async () => {
    const lib = await loadLib();
    assert.deepEqual(lib.parseCsv('a,"b,c","d""e"\r\n\r\n"f\ng",,h\n'), [['a', 'b,c', 'd"e'], ['f\ng', '', 'h']]);
  });

  test('parseCsv throws on a quote that is never closed', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.parseCsv('a,"b\n'), Error);
  });

  test('toCsv quotes only what needs it, every row ending with a line break', async () => {
    const lib = await loadLib();
    assert.equal(lib.toCsv([['a', 'b c', 'x,y'], ['say "hi"', 'two\nlines', '']]), 'a,b c,"x,y"\n"say ""hi""","two\nlines",\n');
    assert.equal(lib.toCsv([]), '');
  });

  test('toCsv and parseCsv round-trip', async () => {
    const lib = await loadLib();
    // a line break inside a field is LF: the brief leaves open whether a quoted CRLF comes back as CRLF
    const rows = [['date', 'payee'], ['2024-01-01', 'Shop, "the" one'], ['x', 'a\nb']];
    assert.deepEqual(lib.parseCsv(lib.toCsv(rows)), rows);
  });
});
