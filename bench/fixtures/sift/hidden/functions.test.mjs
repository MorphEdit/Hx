// Functions and CASE: text, number and date functions, COALESCE, NULLIF, both CASE forms, their types and their errors.
import { describe, test } from 'node:test';
import { change, csv, fails, lines, localToday, ok, query } from './helpers.mjs';

const date = (d) => `CAST('${d}' AS DATE)`;

describe('text functions', { concurrency: true }, () => {
  test('LENGTH counts UTF-16 code units', async () => {
    ok(await csv("SELECT LENGTH('abc'), LENGTH(''), LENGTH('é'), LENGTH('😀'), LENGTH(' a ')"), 'col1,col2,col3,col4,col5', '3,0,1,2,3');
  });

  test('UPPER and LOWER change only the letters a to z and A to Z', async () => {
    ok(await csv("SELECT UPPER('abc-é1'), LOWER('ÀBC-Z'), UPPER('ß')"), 'col1,col2,col3', 'ABC-é1,Àbc-z,ß');
  });

  test('TRIM removes spaces only, at either end', async () => {
    ok(await csv("SELECT TRIM('  a b  '), TRIM('\ta '), TRIM('   '), '[' || TRIM(' x') || ']'"), 'col1,col2,col3,col4', 'a b,\ta,"",[x]');
  });

  test('SUBSTR from a start, with an optional length', async () => {
    ok(await csv("SELECT SUBSTR('hello', 2), SUBSTR('hello', 2, 3), SUBSTR('hello', 9), SUBSTR('hello', 1, 0), SUBSTR('hello', 4, 10), SUBSTR('hello', 6)"),
      'col1,col2,col3,col4,col5,col6', 'ello,ell,"","",lo,""');
  });

  test('SUBSTR with a start below 1 or a length below 0 is a run-time error', async () => {
    fails(await query("SELECT SUBSTR('hello', 0)"), 6);
    fails(await query("SELECT SUBSTR('hello', 1, -1)"), 6);
  });

  test('SUBSTR takes integers for start and length', async () => {
    fails(await query("SELECT SUBSTR('hello', 1.0)"), 5);
    fails(await query("SELECT SUBSTR('hello', 1, '2')"), 5);
  });

  test('REPLACE every occurrence, left to right, not overlapping', async () => {
    ok(await csv("SELECT REPLACE('aaa', 'aa', 'b'), REPLACE('abc', '', 'x'), REPLACE('a.b.c', '.', ''), REPLACE('ab', 'a', '$&$&'), REPLACE('Abc', 'a', 'x')"),
      'col1,col2,col3,col4,col5', 'ba,abc,abc,$&$&b,Abc');
  });

  test('INSTR finds the first occurrence, 0 when none, 1 for the empty text', async () => {
    ok(await csv("SELECT INSTR('hello', 'l'), INSTR('hello', 'z'), INSTR('hello', ''), INSTR('hello', 'lo'), INSTR('', 'a')"), 'col1,col2,col3,col4,col5', '3,0,1,4,0');
  });

  test('INSTR and REPLACE compare case exactly', async () => {
    ok(await csv("SELECT INSTR('Hello', 'h'), INSTR('Hello', 'H'), REPLACE('aAa', 'A', '-')"), 'col1,col2,col3', '0,1,a-a');
  });

  test('text functions take texts', async () => {
    fails(await query('SELECT LENGTH(123)'), 5);
    fails(await query('SELECT UPPER(TRUE)'), 5);
    fails(await query('SELECT TRIM(1.5)'), 5);
  });
});

describe('number functions', { concurrency: true }, () => {
  test('ABS keeps the type', async () => {
    ok(await csv('SELECT ABS(-5), ABS(2.5), ABS(-0.5), ABS(0)'), 'col1,col2,col3,col4', '5,2.5,0.5,0');
  });

  test('ABS of the smallest integer is a run-time error', async () => fails(await query('SELECT ABS(-9223372036854775807 - 1)'), 6));

  test('ROUND a half away from zero; an integer is returned as it is', async () => {
    ok(await csv('SELECT ROUND(2.5), ROUND(-2.45, 1), ROUND(7), ROUND(1.234567, 6), ROUND(-2.5), ROUND(0.05, 1), ROUND(7, 2), ROUND(0.125, 2), ROUND(-0.125, 2)'),
      'col1,col2,col3,col4,col5,col6,col7,col8,col9', '3.0,-2.5,7,1.234567,-3.0,0.1,7,0.13,-0.13');
  });

  test('ROUND to 0 is never -0.0', async () => ok(await csv('SELECT ROUND(-0.4), ROUND(-0.04, 1)'), 'col1,col2', '0.0,0.0'));

  test('ROUND with digits outside 0 to 6 is a run-time error', async () => {
    fails(await query('SELECT ROUND(1.5, 7)'), 6);
    fails(await query('SELECT ROUND(1.5, -1)'), 6);
  });

  test('ROUND takes a number', async () => {
    fails(await query("SELECT ROUND('1.5')"), 5);
  });

  test('FLOOR and CEIL give integers', async () => {
    ok(await csv('SELECT FLOOR(2.5), FLOOR(-2.5), CEIL(2.1), CEIL(-2.1), FLOOR(3), CEIL(-0.5), CEIL(2.1) + 1, FLOOR(5.0)'),
      'col1,col2,col3,col4,col5,col6,col7,col8', '2,-3,3,-2,3,0,4,5');
  });

  test('number functions take numbers', async () => {
    fails(await query("SELECT ABS('1')"), 5);
    fails(await query('SELECT FLOOR(TRUE)'), 5);
  });

  change('ROUND of an integer quotient is a decimal', async () => {
    ok(await csv('SELECT ROUND(7 / 2), ROUND(2 / 3, 2), FLOOR(7 / 2), CEIL(-7 / 2)'), 'col1,col2,col3,col4', '4.0,0.67,3,-3');
  });
});

describe('date functions', { concurrency: true }, () => {
  test('TODAY() is SIFT_TODAY', async () => {
    ok(await csv('SELECT TODAY(), TODAY() + 1'), 'col1,col2', '2024-03-15,2024-03-16');
    ok(await csv('SELECT TODAY()', { today: '2020-02-29' }), 'col1', '2020-02-29');
  });

  test('TODAY() is the local date when SIFT_TODAY is not set', async () => {
    const before = localToday();
    const r = await csv('SELECT TODAY()', { today: null });
    const after = localToday();
    if (r.stdout !== `col1\n${before}\n`) ok(r, 'col1', after);
  });

  test('YEAR, MONTH and DAY', async () => {
    ok(await csv(`SELECT YEAR(${date('2024-03-05')}), MONTH(${date('2024-03-05')}), DAY(${date('2024-03-05')}), YEAR(${date('0001-12-31')})`),
      'col1,col2,col3,col4', '2024,3,5,1');
  });

  test('WEEKDAY is 1 for Monday to 7 for Sunday', async () => {
    ok(await csv(`SELECT WEEKDAY(${date('2024-03-11')}), WEEKDAY(${date('2024-03-15')}), WEEKDAY(${date('2024-03-17')}), WEEKDAY(${date('2000-01-01')})`),
      'col1,col2,col3,col4', '1,5,7,6');
  });

  test('ADD_MONTHS keeps the day, or the last day of a shorter month', async () => {
    ok(await csv(`SELECT ADD_MONTHS(${date('2024-01-31')}, 1), ADD_MONTHS(${date('2024-03-31')}, -1), ADD_MONTHS(${date('2023-01-31')}, 1), ` +
      `ADD_MONTHS(${date('2024-05-15')}, 12), ADD_MONTHS(${date('2024-01-15')}, -13), ADD_MONTHS(${date('2024-02-29')}, 0)`),
    'col1,col2,col3,col4,col5,col6', '2024-02-29,2024-02-29,2023-02-28,2025-05-15,2022-12-15,2024-02-29');
  });

  test('ADD_MONTHS outside the date range is a run-time error', async () => {
    fails(await query(`SELECT ADD_MONTHS(${date('9999-12-01')}, 1)`), 6);
    fails(await query(`SELECT ADD_MONTHS(${date('0001-01-31')}, -1)`), 6);
  });

  test('date functions take dates, and ADD_MONTHS an integer', async () => {
    fails(await query("SELECT YEAR('2024-01-01')"), 5);
    fails(await query('SELECT WEEKDAY(5)'), 5);
    fails(await query(`SELECT ADD_MONTHS(${date('2024-01-01')}, 1.0)`), 5);
  });

  test('date functions over a table column', async () => {
    ok(await csv('SELECT YEAR(d), WEEKDAY(d) FROM t', { tables: { t: lines('d:date', '2024-01-05', '') } }), 'col1,col2', '2024,5', ',');
  });
});

describe('other functions and CASE', { concurrency: true }, () => {
  test('COALESCE gives its first argument that is not NULL', async () => {
    ok(await csv("SELECT COALESCE(NULL, 2, 3), COALESCE(NULL, NULL), COALESCE('a', 'b'), COALESCE(NULL, NULL, 'z')"), 'col1,col2,col3,col4', '2,,a,z');
  });

  test('COALESCE of integers and decimals is a decimal', async () => {
    ok(await csv('SELECT COALESCE(1, 2.5), COALESCE(NULL, 3, 0.5)'), 'col1,col2', '1.0,3.0');
  });

  test('COALESCE stops at its first argument that is not NULL', async () => {
    ok(await csv("SELECT COALESCE(1, CAST('x' AS INTEGER))"), 'col1', '1');
  });

  test('COALESCE takes two arguments or more, of one type', async () => {
    fails(await query('SELECT COALESCE(1)'), 5);
    fails(await query("SELECT COALESCE(1, 'a')"), 5);
  });

  test('NULLIF is NULL when its arguments are equal, else its first', async () => {
    ok(await csv('SELECT NULLIF(1, 1), NULLIF(1, 2), NULLIF(1, 1.0), NULLIF(NULL, 1)'), 'col1,col2,col3,col4', ',1,,');
  });

  test('NULLIF takes comparable arguments', async () => fails(await query("SELECT NULLIF('a', 1)"), 5));

  test('CASE WHEN gives the result of the first TRUE condition', async () => {
    ok(await csv("SELECT CASE WHEN 1 > 2 THEN 'a' WHEN 2 > 1 THEN 'b' WHEN TRUE THEN 'c' ELSE 'd' END, CASE WHEN FALSE THEN 1 END"), 'col1,col2', 'b,');
  });

  test('a CASE WHEN whose condition is NULL is not taken', async () => {
    ok(await csv('SELECT CASE WHEN NULL THEN 1 ELSE 2 END, CASE WHEN NULL = 1 THEN 1 END'), 'col1,col2', '2,');
  });

  test('CASE <value> WHEN gives the first equal one; a NULL value matches nothing', async () => {
    ok(await csv("SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' END, CASE NULL WHEN NULL THEN 'x' ELSE 'y' END, CASE 3 WHEN 1 THEN 'one' END"),
      'col1,col2,col3', 'two,y,');
  });

  test('CASE works out only the result it picks', async () => {
    ok(await csv("SELECT CASE WHEN TRUE THEN 1 ELSE CAST('x' AS INTEGER) END, CASE WHEN FALSE THEN CAST('x' AS INTEGER) WHEN TRUE THEN 2 END"), 'col1,col2', '1,2');
  });

  test('CASE stops at the first TRUE condition, or the first equal value', async () => {
    ok(await csv("SELECT CASE WHEN TRUE THEN 1 WHEN CAST('x' AS INTEGER) = 1 THEN 2 END, CASE 1 WHEN 1 THEN 'a' WHEN CAST('y' AS INTEGER) THEN 'b' END"),
      'col1,col2', '1,a');
  });

  test('CASE results of integers and decimals are a decimal', async () => {
    ok(await csv('SELECT CASE WHEN TRUE THEN 1 ELSE 2.5 END, CASE WHEN FALSE THEN 1 END + 0'), 'col1,col2', '1.0,');
  });

  test('CASE results of different types are exit 5', async () => {
    fails(await query("SELECT CASE WHEN TRUE THEN 1 ELSE 'x' END"), 5);
    fails(await query("SELECT CASE WHEN TRUE THEN 7 / 2 ELSE 'x' END"), 5);
  });

  test('CASE WHEN takes a boolean condition, CASE <value> comparable values', async () => {
    fails(await query("SELECT CASE WHEN 1 THEN 'a' END"), 5);
    fails(await query("SELECT CASE 1 WHEN 'a' THEN 'b' END"), 5);
  });

  test('CASE over table rows', async () => {
    ok(await csv("SELECT CASE WHEN x > 1 THEN 'big' WHEN x IS NULL THEN 'none' ELSE 'small' END FROM t", { tables: { t: lines('x:integer', '1', '2', '') } }),
      'col1', 'small', 'big', 'none');
  });

  test('function names are read in any case', async () => {
    ok(await csv("SELECT length('ab'), Upper('x'), coalesce(NULL, 1), today()"), 'col1,col2,col3,col4', '2,X,1,2024-03-15');
  });

  test('an unknown function is exit 5', async () => fails(await query('SELECT FROBNICATE(1)'), 5));

  test('a wrong number of arguments is exit 5', async () => {
    fails(await query("SELECT LENGTH('a', 'b')"), 5);
    fails(await query("SELECT SUBSTR('a')"), 5);
    fails(await query('SELECT TODAY(1)'), 5);
    fails(await query("SELECT REPLACE('a', 'b')"), 5);
  });

  test('a function gives NULL when an argument is NULL', async () => {
    ok(await csv("SELECT UPPER(NULL), SUBSTR('abc', NULL), ROUND(NULL, 1), ADD_MONTHS(NULL, 1), INSTR(NULL, 'a'), LENGTH(NULL), ABS(NULL), YEAR(NULL), REPLACE('a', NULL, 'b')"),
      'col1,col2,col3,col4,col5,col6,col7,col8,col9', ',,,,,,,,');
  });

  change('a CASE of an integer quotient and an integer is a decimal', async () => {
    ok(await csv('SELECT CASE WHEN TRUE THEN 7 / 2 ELSE 0 END, COALESCE(1 / 0, 5)'), 'col1,col2', '3.5,5.0');
  });

  change('NULLIF of a division by zero', async () => {
    ok(await csv('SELECT NULLIF(1 / 0, 1) IS NULL, NULLIF(6 / 4, 1.5) IS NULL'), 'col1,col2', 'true,true');
  });
});
