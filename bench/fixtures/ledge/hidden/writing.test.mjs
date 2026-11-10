// The commands that write the journal: `account` and `add`. ledge only adds to the end; the rest is never changed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fails, ledge, lines, ok, read, workdir } from './helpers.mjs';

const head = lines('account Assets:Bank', 'account Expenses:Food', 'account Income:Salary');
const shop = ['add', '2024-01-05', 'Corner Shop', 'Expenses:Food', '42.10', 'USD', 'Assets:Bank'];

/** Runs `args` on a journal holding `journal` and returns { r, after }. */
async function write(args, journal, opts = {}) {
  const dir = workdir();
  const r = await ledge(args, { dir, journal, ...opts });
  return { r, after: read(dir, 'ledger.journal') };
}

describe('writing the journal', { concurrency: true }, () => {
  test('account declares an account and prints it', async () => {
    const { r, after } = await write(['account', 'Assets:Bank'], undefined);
    ok(r, 'declared Assets:Bank');
    assert.equal(after, 'account Assets:Bank\n');
  });

  test('account adds its line with no blank line before it', async () => {
    const { after } = await write(['account', 'Assets:Cash'], lines('account Assets:Bank', '', '2024-01-01 x', '    Assets:Bank  0.00 USD',
      '    Assets:Bank'));
    assert.equal(after, lines('account Assets:Bank', '', '2024-01-01 x', '    Assets:Bank  0.00 USD', '    Assets:Bank', 'account Assets:Cash'));
  });

  test('account adds the missing line break first', async () => {
    const { after } = await write(['account', 'Assets:Cash'], 'account Assets:Bank');
    assert.equal(after, 'account Assets:Bank\naccount Assets:Cash\n');
  });

  test('account: an account already declared is exit 5, the file unchanged', async () => {
    const { r, after } = await write(['account', 'Assets:Bank'], head);
    fails(r, 5);
    assert.equal(after, head);
  });

  test('account: a malformed name is exit 1', async () => {
    fails((await write(['account', 'Bank'], head)).r, 1);
    fails((await write(['account'], head)).r, 1);
  });

  test('add writes the transaction after a blank line and prints it', async () => {
    const { r, after } = await write(shop, head);
    ok(r, 'added 2024-01-05 Corner Shop');
    assert.equal(after, head + lines('', '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD'));
  });

  test('account creates a missing journal, one line after another', async () => {
    const dir = workdir();
    ok(await ledge(['account', 'Assets:Bank'], { dir }), 'declared Assets:Bank');
    ok(await ledge(['account', 'Expenses:Food'], { dir }), 'declared Expenses:Food');
    assert.equal(read(dir, 'ledger.journal'), lines('account Assets:Bank', 'account Expenses:Food'));
  });

  test('add to an empty journal: nothing is declared, exit 5, the file stays empty', async () => {
    const { r, after } = await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'], '');
    fails(r, 5);
    assert.equal(after, '');
  });

  test('add when the accounts are declared in an included file', async () => {
    const dir = workdir({ 'acc.journal': head });
    ok(await ledge(shop, { dir, journal: 'include acc.journal\n' }), 'added 2024-01-05 Corner Shop');
    assert.equal(read(dir, 'ledger.journal'), lines('include acc.journal', '', '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD',
      '    Assets:Bank  -42.10 USD'));
  });

  test('add after a blank last line writes no second blank line', async () => {
    const { after } = await write(shop, head + '  \n');
    assert.equal(after, head + lines('  ', '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD'));
  });

  test('add after a last line with no line break adds the break, then the blank line', async () => {
    const { after } = await write(shop, head.trimEnd());
    assert.equal(after, head + lines('', '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD'));
  });

  test('add keeps the CRLF lines already there and writes LF', async () => {
    const crlf = head.replaceAll('\n', '\r\n');
    const { after } = await write(shop, crlf);
    assert.equal(after, crlf + lines('', '2024-01-05 Corner Shop', '    Expenses:Food  42.10 USD', '    Assets:Bank  -42.10 USD'));
  });

  test('add fills in the missing amount', async () => {
    const { r, after } = await write(['add', '2024-01-31', 'ACME', 'Assets:Bank', '3000.00', 'USD', 'Income:Salary'], head);
    ok(r, 'added 2024-01-31 ACME');
    assert.ok(after.endsWith(lines('2024-01-31 ACME', '    Assets:Bank  3000.00 USD', '    Income:Salary  -3000.00 USD')), after);
  });

  test('add with the missing amount first', async () => {
    const { after } = await write(['add', '2024-01-31', 'ACME', 'Income:Salary', 'Assets:Bank', '10.00', 'USD', 'Assets:Bank', '5.50', 'USD'], head);
    assert.ok(after.endsWith(lines('2024-01-31 ACME', '    Income:Salary  -15.50 USD', '    Assets:Bank  10.00 USD', '    Assets:Bank  5.50 USD')), after);
  });

  test('add writes amounts normalised', async () => {
    const { after } = await write(['add', '2024-01-05', 'x', 'Expenses:Food', '0001.50', 'USD', 'Assets:Bank', '-1.50', 'USD'], head);
    assert.ok(after.endsWith(lines('2024-01-05 x', '    Expenses:Food  1.50 USD', '    Assets:Bank  -1.50 USD')), after);
  });

  test('add with two currencies that each balance', async () => {
    const { r } = await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank', '-1.00', 'USD',
      'Expenses:Food', '2.00', 'EUR', 'Assets:Bank', '-2.00', 'EUR'], head);
    ok(r, 'added 2024-01-05 x');
  });

  test('add today uses LEDGE_TODAY', async () => {
    const { r, after } = await write(['add', 'today', 'Lunch', 'Expenses:Food', '9.00', 'USD', 'Assets:Bank'], head, { today: '2024-07-04' });
    ok(r, 'added 2024-07-04 Lunch');
    assert.ok(after.includes('\n2024-07-04 Lunch\n'), after);
  });

  test('add drops whitespace at the ends of the payee', async () => {
    const { r, after } = await write(['add', '2024-01-05', '  Corner Shop \t', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'], head);
    ok(r, 'added 2024-01-05 Corner Shop');
    assert.ok(after.includes('\n2024-01-05 Corner Shop\n'), after);
  });

  test('add reads back: the written transaction is in the balance', async () => {
    const dir = workdir();
    await ledge(shop, { dir, journal: head });
    ok(await ledge(['balance'], { dir }), 'Assets:Bank -42.10 USD', 'Expenses:Food 42.10 USD', 'total 0.00 USD');
  });

  test('add: usage errors are exit 1 and change nothing', async () => {
    for (const args of [
      ['add'], ['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD'], ['add', '2024-02-30', 'x', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'],
      ['add', '2024-01-05', '   ', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'], ['add', '2024-01-05', 'a\nb', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank'],
      ['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'Assets:Bank'], ['add', '2024-01-05', 'x', 'Expenses:Food', '1.0', 'USD', 'Assets:Bank'],
      ['add', '2024-01-05', 'x', 'food', '1.00', 'USD', 'Assets:Bank'], ['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'usd', 'Assets:Bank'],
    ]) {
      const { r, after } = await write(args, head);
      fails(r, 1);
      assert.equal(after, head, args.join(' '));
    }
  });

  test('add: an account that is not declared is exit 5', async () => {
    const { r, after } = await write(['add', '2024-01-05', 'x', 'Expenses:Rent', '1.00', 'USD', 'Assets:Bank'], head);
    fails(r, 5);
    assert.equal(after, head);
  });

  test('add: two postings without an amount is exit 5', async () => {
    fails((await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank', 'Income:Salary'], head)).r, 5);
  });

  test('add: a missing amount with two currencies is exit 5', async () => {
    fails((await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD', 'Expenses:Food', '1.00', 'EUR', 'Assets:Bank'], head)).r, 5);
  });

  test('add: amounts that do not balance are exit 5, the file unchanged', async () => {
    const { r, after } = await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD', 'Assets:Bank', '-2.00', 'USD'], head);
    fails(r, 5);
    assert.equal(after, head);
  });

  test('add: a usage error wins over a bad journal, and a bad journal over the command check', async () => {
    fails((await write(['add', '2024-01-05', 'x', 'Expenses:Food', '1.00', 'USD'], 'oops\n')).r, 1);
    fails((await write(['add', '2024-01-05', 'x', 'Expenses:Rent', '1.00', 'USD', 'Assets:Bank'], 'oops\n')).r, 3);
  });
});
