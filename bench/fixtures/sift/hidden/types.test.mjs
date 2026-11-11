// Types and values: table files read as typed values, operators, casts, comparisons, LIKE, NULL and three-valued logic.
import { describe, test } from 'node:test';
import { FRUIT, change, csv, fails, fileErrorAt, lines, ok, query } from './helpers.mjs';

const one = (body) => ({ tables: { t: body } });
const badFile = async (body, line) => fileErrorAt(await query('SELECT * FROM t', one(body)), 't.csv', line);

describe('reading table files', { concurrency: true }, () => {
  test('every column is read as its type', async () => {
    ok(await csv('SELECT * FROM fruit', { tables: { fruit: FRUIT } }),
      'id,name,price,in_stock,added', '1,apple,1.5,true,2024-01-05', '2,"pear, green",0.25,false,', '3,"",12.0,true,2023-12-31', '4,,,,');
  });

  test('a quoted empty field is the empty text in a text column and NULL in any other', async () => {
    ok(await csv("SELECT a IS NULL, b = '', b IS NULL, c IS NULL, d IS NULL, e IS NULL FROM t",
      one(lines('a:integer,b:text,c:decimal,d:boolean,e:date', '"","","","",""'))), 'col1,col2,col3,col4,col5,col6', 'true,true,false,true,true,true');
  });

  test('an unquoted empty field is NULL in every column, text included', async () => {
    ok(await csv('SELECT a IS NULL, b IS NULL FROM t', one(lines('a:integer,b:text', ','))), 'col1,col2', 'true,true');
  });

  test('quoting a field changes nothing else', async () => {
    ok(await csv('SELECT a + 1, b, c + 1, d FROM t', one(lines('a:integer,b:text,c:date,d:boolean', '"5","x","2024-01-01","true"'))),
      'col1,b,col3,d', '6,x,2024-01-02,true');
  });

  test('header columns are turned to small letters and types are read in any case', async () => {
    ok(await csv('SELECT * FROM t', one(lines('ID:INTEGER,Name:Text', '1,x'))), 'id,name', '1,x');
  });

  test('a byte-order mark at the start is skipped', async () => {
    ok(await csv('SELECT a FROM t', one('﻿a:integer\n1\n')), 'a', '1');
  });

  test('rows end with \\n or \\r\\n, and the last one may end without', async () => {
    ok(await csv('SELECT * FROM t', one('a:integer,b:text\r\n1,x\n2,y\r\n3,z')), 'a,b', '1,x', '2,y', '3,z');
  });

  test('an empty line in a table of one column is a row holding NULL', async () => {
    ok(await csv('SELECT a IS NULL FROM t', one('a:text\nx\n\ny\n')), 'col1', 'false', 'true', 'false');
  });

  test('a line break at the very end of the file does not start another row', async () => {
    ok(await csv('SELECT a FROM t', one('a:text\nx\n')), 'a', 'x');
  });

  test('a line break inside quotes is kept exactly as written', async () => {
    ok(await csv("SELECT LENGTH(a), a LIKE 'x__y' FROM t", one('a:text\r\n"x\r\ny"\r\n"p\nq"\r\n')), 'col1,col2', '4,true', '3,false');
  });

  test('a doubled double quote inside quotes is one double quote', async () => {
    ok(await csv('SELECT a = \'say "hi"\', LENGTH(a) FROM t', one('a:text\n"say ""hi"""\n')), 'col1,col2', 'true,8');
  });

  test('a text field keeps its spaces', async () => {
    ok(await csv('SELECT LENGTH(a) FROM t', one('a:text\n  padded  \n')), 'col1', '10');
  });

  test('integers: leading zeros, -0 and both ends of the range', async () => {
    ok(await csv('SELECT a FROM t', one(lines('a:integer', '007', '-0', '9223372036854775807', '-9223372036854775808'))),
      'a', '7', '0', '9223372036854775807', '-9223372036854775808');
  });

  test('decimals: no point, up to 6 digits after it, up to 18 before it', async () => {
    ok(await csv('SELECT a FROM t', one(lines('a:decimal', '5', '5.25', '-0.000001', '0.10', '-0', '999999999999999999.999999'))),
      'a', '5.0', '5.25', '-0.000001', '0.1', '0.0', '999999999999999999.999999');
  });

  test('dates from 0001-01-01 to 9999-12-31, leap days included', async () => {
    ok(await csv('SELECT a FROM t', one(lines('a:date', '0001-01-01', '9999-12-31', '2024-02-29', '2000-02-29'))),
      'a', '0001-01-01', '9999-12-31', '2024-02-29', '2000-02-29');
  });

  test('a bad integer is an error naming the file and the line of its row', () => badFile(lines('a:integer', '1', '12x'), 3));

  test('an integer outside the range is an error', () => badFile(lines('a:integer', '9223372036854775808'), 2));

  test('nothing is trimmed: " 5" is not an integer', () => badFile(lines('a:integer', ' 5'), 2));

  test('an integer has no + sign', () => badFile(lines('a:integer', '+5'), 2));

  test('a decimal must be digits with an optional point and 1 to 6 digits', async () => {
    for (const bad of ['.5', '5.', '1e3', '1.1234567', '1234567890123456789', '1,5', '- 1']) await badFile(lines('a:decimal', '1', `"${bad}"`), 3);
  });

  test('a boolean is true or false in small letters', async () => {
    for (const bad of ['TRUE', 'False', 'yes', '1']) await badFile(lines('a:boolean', bad), 2);
  });

  test('a date must be a real date written YYYY-MM-DD', async () => {
    for (const bad of ['2023-02-29', '2024-1-05', '0000-01-01', '2024-01-05 ', '2024/01/05', '1900-02-29']) await badFile(lines('a:date', bad), 2);
  });

  test('a quote that is never closed is an error', () => badFile('a:text\nx\n"y\n', 3));

  test('anything but a comma or the end of the row after a closing quote is an error', () => badFile(lines('a:text', '"x"y'), 2));

  test('a field that does not start with a quote must not contain one', () => badFile(lines('a:text', 'x"y'), 2));

  test('a row with too few fields is an error', () => badFile(lines('a:integer,b:integer', '1,2', '3'), 3));

  test('a row with too many fields is an error', () => badFile(lines('a:integer,b:integer', '1,2,3'), 2));

  test('an empty line in a wider table is a row with the wrong number of fields', () => badFile('a:integer,b:integer\n1,2\n\n', 3));

  test('the line of a row counts the line breaks inside quotes before it', () => badFile('a:text,b:integer\n"x\ny",1\nz,bad\n', 4));

  test('the first error in the file is the one reported', () => badFile(lines('a:integer', '1', 'x', 'y'), 3));

  test('a header field without its type is an error on line 1', () => badFile(lines('a', '1'), 1));

  test('a header type that is not one of the five is an error on line 1', () => badFile(lines('a:money', '1'), 1));

  test('two header columns of the same name, in any case, are an error on line 1', () => badFile(lines('a:integer,A:text', '1,x'), 1));

  test('a header field with a space is an error on line 1', () => badFile(lines('a :integer', '1'), 1));

  test('a header column must be an identifier', async () => {
    await badFile(lines('1a:integer', '1'), 1);
    await badFile(lines('select:integer', '1'), 1);
  });

  test('an empty file is an error naming the file', async () => {
    const r = await query('SELECT * FROM t', one(''));
    fails(r, 4);
    if (!r.stderr.includes('t.csv')) throw new Error(`the message names t.csv: ${r.stderr}`);
  });
});

describe('operators', { concurrency: true }, () => {
  test('integer + - * % give integers, % with the sign of its left side', async () => {
    ok(await csv('SELECT 2 + 3, 2 - 5, 4 * -3, 7 % 3, -7 % 3, 7 % -3'), 'col1,col2,col3,col4,col5,col6', '5,-3,-12,1,-1,1');
  });

  test('an integer with a decimal gives a decimal', async () => {
    ok(await csv('SELECT 1 + 0.5, 2 * 1.5, 3 - 3.0, 4.0 - 1'), 'col1,col2,col3,col4', '1.5,3.0,0.0,3.0');
  });

  test('decimal + and - are exact', async () => {
    ok(await csv('SELECT 0.1 + 0.2, 0.000001 - 0.000002, 999999999999999998.5 + 1'), 'col1,col2,col3', '0.3,-0.000001,999999999999999999.5');
  });

  test('decimal * and / round to 6 digits after the point, a half away from zero', async () => {
    ok(await csv('SELECT 0.000005 * 0.1, -0.000005 * 0.1, 1.5 * 1.5, 1.0 / 3, 2.0 / 3, 7.5 / 2.5, -2.0 / 3'),
      'col1,col2,col3,col4,col5,col6,col7', '0.000001,-0.000001,2.25,0.333333,0.666667,3.0,-0.666667');
  });

  test('% takes integers only', async () => fails(await query('SELECT 7.0 % 2'), 5));

  test('arithmetic on a text is a type error', async () => {
    fails(await query("SELECT 'a' + 1"), 5);
    fails(await query("SELECT -'a'"), 5);
    fails(await query('SELECT TRUE * 2'), 5);
  });

  test('an integer result outside the range is a run-time error', async () => {
    fails(await query('SELECT 9223372036854775807 + 1'), 6);
    fails(await query('SELECT -9223372036854775807 - 2'), 6);
    fails(await query('SELECT 4611686018427387904 * 2'), 6);
  });

  test('the smallest integer is reached by arithmetic', async () => {
    ok(await csv('SELECT -9223372036854775807 - 1'), 'col1', '-9223372036854775808');
  });

  test('a decimal result of 10^18 or more is a run-time error', async () => {
    fails(await query('SELECT 999999999999999999.0 + 1'), 6);
    fails(await query('SELECT 999999999999999999.0 * 2'), 6);
  });

  test('decimals print without leading or trailing zeros but one digit after the point, never -0.0', async () => {
    ok(await csv('SELECT 2.50, 0.125, -0.5, -0.0, 0.5 - 0.5, 0.0 * -1, 007.5'), 'col1,col2,col3,col4,col5,col6,col7', '2.5,0.125,-0.5,0.0,0.0,0.0,7.5');
  });

  test('-0 is printed 0', async () => ok(await csv('SELECT -0, 0 * -5'), 'col1,col2', '0,0'));

  test('dates move by days with + and -, and two dates subtract to days', async () => {
    ok(await csv("SELECT CAST('2024-02-28' AS DATE) + 2, 1 + CAST('2024-12-31' AS DATE), CAST('2024-03-01' AS DATE) - 1, " +
      "CAST('2024-03-01' AS DATE) - CAST('2024-02-01' AS DATE), CAST('2024-01-01' AS DATE) - CAST('2024-01-31' AS DATE)"),
    'col1,col2,col3,col4,col5', '2024-03-01,2025-01-01,2024-02-29,29,-30');
  });

  test('a date outside the range is a run-time error', async () => {
    fails(await query("SELECT CAST('9999-12-31' AS DATE) + 1"), 6);
    fails(await query("SELECT CAST('0001-01-01' AS DATE) - 1"), 6);
  });

  test('no other arithmetic takes a date', async () => {
    fails(await query("SELECT CAST('2024-01-01' AS DATE) * 2"), 5);
    fails(await query("SELECT CAST('2024-01-01' AS DATE) + CAST('2024-01-02' AS DATE)"), 5);
    fails(await query("SELECT CAST('2024-01-01' AS DATE) + 1.5"), 5);
    fails(await query("SELECT 1 - CAST('2024-01-01' AS DATE)"), 5);
  });

  test('|| turns a side that is not a text into text', async () => {
    ok(await csv("SELECT 1 || 'a', 2.50 || '', TRUE || 'x', CAST('2024-01-05' AS DATE) || '', 1 || 2"), 'col1,col2,col3,col4,col5', '1a,2.5,truex,2024-01-05,12');
  });

  test('comparisons of integers with decimals go by value', async () => {
    ok(await csv('SELECT 1 = 1.0, 2 > 1.5, 1.5 IN (1, 2), 3 BETWEEN 2.5 AND 3.0'), 'col1,col2,col3,col4', 'true,true,false,true');
  });

  test('texts compare by character codes', async () => {
    ok(await csv("SELECT 'B' < 'a', 'ab' < 'b', 'a' = 'A', '' < 'a', 'Z' >= 'Z'"), 'col1,col2,col3,col4,col5', 'true,true,false,true,true');
  });

  test('false comes before true', async () => ok(await csv('SELECT FALSE < TRUE, TRUE <= FALSE'), 'col1,col2', 'true,false'));

  test('dates compare by time', async () => {
    ok(await csv("SELECT CAST('2023-12-31' AS DATE) < CAST('2024-01-01' AS DATE)"), 'col1', 'true');
  });

  test('a text compared with a date is turned into a date', async () => {
    ok(await csv("SELECT CAST('2024-01-05' AS DATE) > '2024-01-01', '2024-03-01' = CAST('2024-03-01' AS DATE), CAST('2024-01-05' AS DATE) IN ('2024-01-05')"),
      'col1,col2,col3', 'true,true,true');
  });

  test('a text that is not a date compared with a date is a run-time error', async () => {
    fails(await query("SELECT CAST('2024-01-05' AS DATE) = 'soon'"), 6);
  });

  test('comparing other pairs of types is a type error', async () => {
    for (const sql of ["SELECT 1 = '1'", 'SELECT TRUE = 1', "SELECT CAST('2024-01-01' AS DATE) < 5", "SELECT 1 IN ('a')", "SELECT 'a' BETWEEN 1 AND 2"]) {
      fails(await query(sql), 5);
    }
  });

  test('AND, OR, NOT and WHERE take booleans only', async () => {
    fails(await query('SELECT 1 AND TRUE'), 5);
    fails(await query("SELECT NOT 'x'"), 5);
    fails(await query('SELECT 1 WHERE 1'), 5);
  });

  test('a type error is found before anything runs, even over no rows', async () => {
    fails(await query("SELECT name + 1 FROM t WHERE id = CAST('x' AS INTEGER)", one(lines('id:integer,name:text'))), 5);
  });

  test('three-valued logic for AND, OR and NOT', async () => {
    ok(await csv('SELECT NULL AND FALSE, NULL AND TRUE, NULL OR TRUE, NULL OR FALSE, NOT NULL, FALSE AND NULL, TRUE OR NULL'),
      'col1,col2,col3,col4,col5,col6,col7', 'false,,true,,,false,true');
  });

  test('IS NULL and IS NOT NULL are never NULL', async () => {
    ok(await csv('SELECT NULL IS NULL, 1 IS NULL, NULL IS NOT NULL, 1 IS NOT NULL'), 'col1,col2,col3,col4', 'true,false,false,true');
  });

  test('every other operator gives NULL when a side is NULL', async () => {
    ok(await csv("SELECT 1 + NULL, NULL = NULL, 'a' || NULL, NULL < 1, -NULL, NULL LIKE 'a', 2 * NULL"), 'col1,col2,col3,col4,col5,col6,col7', ',,,,,,');
  });

  test('IN is TRUE on a match, else NULL when a NULL is involved, else FALSE', async () => {
    ok(await csv('SELECT 1 IN (1, NULL), 1 IN (2, NULL), 1 NOT IN (2, NULL), NULL IN (1), 1 IN (2, 3), 1 NOT IN (2, 3), NULL NOT IN (1)'),
      'col1,col2,col3,col4,col5,col6,col7', 'true,,,,false,true,');
  });

  test('BETWEEN is worked out as its AND', async () => {
    ok(await csv('SELECT 5 BETWEEN NULL AND 3, 5 BETWEEN 1 AND NULL, 2 BETWEEN 1 AND 3, 2 NOT BETWEEN 1 AND 3, 3 BETWEEN 3 AND 3'),
      'col1,col2,col3,col4,col5', 'false,,true,false,true');
  });

  test('LIKE: % is any run, _ is one character, and the pattern matches the whole text', async () => {
    ok(await csv("SELECT 'abc' LIKE 'ab', 'abc' LIKE '%', '' LIKE '%', 'a' LIKE '_', 'ab' LIKE '_', 'abc' LIKE 'a%c', 'abc' LIKE '%b%', 'abc' LIKE '_b_'"),
      'col1,col2,col3,col4,col5,col6,col7,col8', 'false,true,true,true,false,true,true,true');
  });

  test('LIKE has no other special character and no escape', async () => {
    ok(await csv("SELECT 'abc' LIKE 'a.c', 'a.c' LIKE 'a.c', 'a+b' LIKE 'a+b', 'a(b' LIKE 'a(b', 'a\\b' LIKE 'a\\b', 'a%' LIKE 'a\\%', '[x]' LIKE '[x]', 'x*' LIKE 'x*'"),
      'col1,col2,col3,col4,col5,col6,col7,col8', 'false,true,true,true,true,false,true,true');
  });

  test('LIKE matches across line breaks', async () => ok(await csv("SELECT 'a\nb' LIKE 'a_b', 'a\nb' LIKE 'a%'"), 'col1,col2', 'true,true'));

  test('LIKE takes two texts', async () => {
    fails(await query("SELECT 1 LIKE '1'"), 5);
    fails(await query("SELECT 'a' LIKE 1"), 5);
  });

  test('LIKE compares every character but the letters A to Z exactly', async () => {
    ok(await csv("SELECT 'é' LIKE 'É', 'ß' LIKE 'SS', 'é' LIKE 'é'"), 'col1,col2,col3', 'false,false,true');
  });

  test('= and the ordering of texts still compare case exactly', async () => {
    ok(await csv("SELECT 'Apple' = 'apple', 'Apple' < 'apple', 'a' IN ('A')"), 'col1,col2,col3', 'false,true,false');
  });

  change('LIKE ignores the case of the letters A to Z', async () => {
    ok(await csv("SELECT 'Apple' LIKE 'a%', 'APPLE' LIKE '%pp%', 'abc' LIKE 'A_C', 'ABC' LIKE 'a_c', 'xYz' LIKE 'XyZ'"),
      'col1,col2,col3,col4,col5', 'true,true,true,true,true');
  });

  change('NOT LIKE ignores case too', async () => {
    ok(await csv("SELECT 'abc' NOT LIKE 'ABC', 'Apple' NOT LIKE 'b%'"), 'col1,col2', 'false,true');
  });

  change('LIKE in WHERE ignores case', async () => {
    ok(await csv("SELECT id FROM fruit WHERE name LIKE 'P%'", { tables: { fruit: FRUIT } }), 'id', '2');
  });

  change('two integers divide into a decimal of 6 digits after the point', async () => {
    ok(await csv('SELECT 7 / 2, -7 / 2, 6 / 3, 1 / 3, 2 / 3, -2 / 3'), 'col1,col2,col3,col4,col5,col6', '3.5,-3.5,2.0,0.333333,0.666667,-0.666667');
  });

  change('integer division rounds a half away from zero', async () => {
    ok(await csv('SELECT 1 / 2000000, -1 / 2000000, 1 / 3000000'), 'col1,col2,col3', '0.000001,-0.000001,0.0');
  });

  change('integer division is a decimal in what uses it', async () => {
    ok(await csv("SELECT CAST(7 / 2 AS INTEGER), 7 / 2 || '', 9 / 4 * 4, 1 / 3 + 1"), 'col1,col2,col3,col4', '3,3.5,9.0,1.333333');
  });

  change('integer division is a decimal before anything runs: % of it is a type error', async () => {
    fails(await query('SELECT 7 / 2 % 2'), 5);
  });

  change('integer division over table columns', async () => {
    ok(await csv('SELECT a / b FROM t', one(lines('a:integer,b:integer', '7,2', '-9,4', '10,5'))), 'col1', '3.5', '-2.25', '2.0');
  });

  change('dividing by zero gives NULL, for integers and decimals', async () => {
    ok(await csv('SELECT 1 / 0, 1.5 / 0.0, 7 % 0, 0 / 0, 1 / 0.0, -5 % 0, 2.5 / 0'), 'col1,col2,col3,col4,col5,col6,col7', ',,,,,,');
  });

  change('a NULL from a division by zero goes on as any NULL', async () => {
    ok(await csv('SELECT COALESCE(1 / 0, -1), (1 / 0) IS NULL, 7 % 0 IS NULL, 1 / 0 + 1'), 'col1,col2,col3,col4', '-1.0,true,true,');
  });

  change('a division by zero in WHERE drops the row instead of failing', async () => {
    ok(await csv('SELECT a FROM t WHERE 10 / (a - 2) > 1', one(lines('a:integer', '1', '2', '3'))), 'a', '3');
  });

  test('the other run-time errors are unchanged by the change: overflow is still exit 6', async () => {
    fails(await query('SELECT 9223372036854775807 * 2'), 6);
  });
});

describe('casts', { concurrency: true }, () => {
  test('to text: as sift prints the value', async () => {
    ok(await csv("SELECT CAST(1.50 AS TEXT), CAST(FALSE AS TEXT), CAST(-3 AS TEXT), CAST(CAST('2024-01-05' AS DATE) AS TEXT), CAST('x' AS TEXT)"),
      'col1,col2,col3,col4,col5', '1.5,false,-3,2024-01-05,x');
  });

  test('to integer: decimals toward zero, booleans as 1 and 0, texts as written in a table file', async () => {
    ok(await csv("SELECT CAST(-2.7 AS INTEGER), CAST(2.7 AS INTEGER), CAST(TRUE AS INTEGER), CAST(FALSE AS INTEGER), CAST('-007' AS INTEGER)"),
      'col1,col2,col3,col4,col5', '-2,2,1,0,-7');
  });

  test('to integer: a text that is not an integer is a run-time error', async () => {
    for (const bad of [' 5', '5.0', '+5', '', 'x', '9223372036854775808']) fails(await query(`SELECT CAST('${bad}' AS INTEGER)`), 6);
  });

  test('to integer: a date is a type error', async () => fails(await query("SELECT CAST(CAST('2024-01-01' AS DATE) AS INTEGER)"), 5));

  test('to decimal: integers and texts written as a table file decimal', async () => {
    ok(await csv("SELECT CAST(5 AS DECIMAL), CAST('-0.000001' AS DECIMAL), CAST('5' AS DECIMAL), CAST('0012.50' AS DECIMAL)"),
      'col1,col2,col3,col4', '5.0,-0.000001,5.0,12.5');
  });

  test('to decimal: a text that is not a decimal is a run-time error', async () => {
    for (const bad of ['.5', '5.', '1e3', '1.1234567', ' 1']) fails(await query(`SELECT CAST('${bad}' AS DECIMAL)`), 6);
  });

  test('to decimal: an integer of 10^18 or more is a run-time error', async () => fails(await query('SELECT CAST(9223372036854775807 AS DECIMAL)'), 6));

  test('to decimal: a boolean or a date is a type error', async () => {
    fails(await query('SELECT CAST(TRUE AS DECIMAL)'), 5);
    fails(await query("SELECT CAST(CAST('2024-01-01' AS DATE) AS DECIMAL)"), 5);
  });

  test('to boolean: 0 is false, any other integer true, texts true and false', async () => {
    ok(await csv("SELECT CAST(0 AS BOOLEAN), CAST(-3 AS BOOLEAN), CAST('true' AS BOOLEAN), CAST('false' AS BOOLEAN)"), 'col1,col2,col3,col4', 'false,true,true,false');
  });

  test('to boolean: another text is a run-time error, a decimal a type error', async () => {
    fails(await query("SELECT CAST('TRUE' AS BOOLEAN)"), 6);
    fails(await query('SELECT CAST(1.0 AS BOOLEAN)'), 5);
  });

  test('to date: a real date written YYYY-MM-DD', async () => {
    ok(await csv("SELECT CAST('2024-02-29' AS DATE), CAST('0001-01-01' AS DATE)"), 'col1,col2', '2024-02-29,0001-01-01');
  });

  test('to date: a text that is not a real date is a run-time error, another type a type error', async () => {
    for (const bad of ['2023-02-29', '2024-2-29', '10000-01-01', '2024-04-31']) fails(await query(`SELECT CAST('${bad}' AS DATE)`), 6);
    fails(await query('SELECT CAST(1 AS DATE)'), 5);
  });

  test('NULL casts to NULL of any type, and a value to its own type is kept', async () => {
    ok(await csv('SELECT CAST(NULL AS INTEGER), CAST(NULL AS DATE), CAST(2.5 AS DECIMAL) + 0, CAST(NULL AS TEXT) IS NULL'), 'col1,col2,col3,col4', ',,2.5,true');
  });

  test('the type of a cast is its target: CAST(1 AS TEXT) || is text, CAST(1 AS DECIMAL) prints 1.0', async () => {
    ok(await csv('SELECT CAST(1 AS TEXT) || CAST(2 AS TEXT), CAST(1 AS DECIMAL), CAST(1 AS integer), CAST(1 AS Text)'), 'col1,col2,col3,col4', '12,1.0,1,1');
  });
});
