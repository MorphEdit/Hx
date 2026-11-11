// Grouping and aggregates: COUNT, SUM, AVG, MIN, MAX, GROUP BY, HAVING, what a grouped query may name.
import { describe, test } from 'node:test';
import { SALES, change, csv, fails, lines, ok, query } from './helpers.mjs';

const sales = { tables: { sales: SALES } };
const nums = (...values) => ({ tables: { t: lines('x:integer', ...values) } });
const decs = (...values) => ({ tables: { t: lines('x:decimal', ...values) } });

describe('aggregates', { concurrency: true }, () => {
  test('COUNT(*) counts the rows, COUNT(x) the rows where x is not NULL', async () => {
    ok(await csv('SELECT COUNT(*), COUNT(qty), COUNT(region), COUNT(day) FROM sales', sales), 'col1,col2,col3,col4', '6,5,5,5');
  });

  test('a grouped query without GROUP BY gives one row even with no rows', async () => {
    ok(await csv('SELECT COUNT(*), COUNT(qty), SUM(qty), AVG(qty), MIN(qty), MAX(qty) FROM sales WHERE FALSE', sales),
      'col1,col2,col3,col4,col5,col6', '0,0,,,,');
  });

  test('an aggregate with no FROM works over the one row', async () => ok(await csv('SELECT COUNT(*), SUM(2)'), 'col1,col2', '1,2'));

  test('SUM of integers is an integer, of decimals a decimal', async () => {
    ok(await csv('SELECT SUM(qty), SUM(price) FROM sales', sales), 'col1,col2', '15,6.75');
  });

  test('SUM of decimals is exact', async () => ok(await csv('SELECT SUM(x) FROM t', decs('0.1', '0.1', '0.1')), 'col1', '0.3'));

  test('SUM outside the integer range is a run-time error', async () => {
    fails(await query('SELECT SUM(x) FROM t', nums('9223372036854775807', '1')), 6);
  });

  test('AVG is a decimal rounded to 6 digits, a half away from zero', async () => {
    ok(await csv('SELECT AVG(x) FROM t', nums('1', '2', '2')), 'col1', '1.666667');
    ok(await csv('SELECT AVG(x) FROM t', nums('-1', '-2', '-2')), 'col1', '-1.666667');
    ok(await csv('SELECT AVG(x) FROM t', decs('0.000001', '0.000002')), 'col1', '0.000002');
  });

  test('AVG of integers is a decimal even when it is whole, and skips NULLs', async () => {
    ok(await csv('SELECT AVG(qty), AVG(price) FROM sales', sales), 'col1,col2', '3.0,1.35');
  });

  test('MIN and MAX skip NULLs and keep the type, for every type', async () => {
    ok(await csv('SELECT MIN(region), MAX(region), MIN(day), MAX(day), MIN(price), MAX(price), MIN(qty), MAX(qty) FROM sales', sales),
      'col1,col2,col3,col4,col5,col6,col7,col8', 'east,south,2024-01-02,2024-02-10,0.5,2.0,1,5');
  });

  test('MIN and MAX of booleans and of texts by character codes', async () => {
    const tables = { t: lines('b:boolean,s:text', 'true,b', 'false,B', ',a') };
    ok(await csv('SELECT MIN(b), MAX(b), MIN(s), MAX(s) FROM t', { tables }), 'col1,col2,col3,col4', 'false,true,B,b');
  });

  test('every aggregate but COUNT is NULL over values that are all NULL', async () => {
    ok(await csv('SELECT COUNT(x), SUM(x), AVG(x), MIN(x), MAX(x) FROM t', nums('', '')), 'col1,col2,col3,col4,col5', '0,,,,');
  });

  test('an aggregate over the NULL literal is NULL, COUNT(NULL) is 0', async () => {
    ok(await csv('SELECT COUNT(NULL), SUM(NULL), MAX(NULL), AVG(NULL) FROM sales', sales), 'col1,col2,col3,col4', '0,,,');
  });

  test('SUM and AVG take numbers only', async () => {
    fails(await query('SELECT SUM(region) FROM sales', sales), 5);
    fails(await query('SELECT AVG(day) FROM sales', sales), 5);
  });

  test('an aggregate takes exactly one argument', async () => {
    fails(await query('SELECT SUM(qty, price) FROM sales', sales), 5);
    fails(await query('SELECT MAX() FROM sales', sales), 5);
  });

  test('GROUP BY gives the groups in the order of their first row, NULLs one group', async () => {
    ok(await csv('SELECT region, COUNT(*), SUM(qty) FROM sales GROUP BY region', sales),
      'region,col2,col3', 'north,2,5', 'south,2,1', 'east,1,5', ',1,4');
  });

  test('GROUP BY groups texts case exact', async () => {
    ok(await csv('SELECT c, COUNT(*) FROM t GROUP BY c', { tables: { t: lines('c:text', 'Oslo', 'oslo', 'Oslo') } }), 'c,col2', 'Oslo,2', 'oslo,1');
  });

  test('GROUP BY the first row of each group after WHERE', async () => {
    ok(await csv("SELECT region FROM sales WHERE product <> 'apple' GROUP BY region", sales), 'region', 'south', 'north', '');
  });

  test('GROUP BY several items', async () => {
    ok(await csv('SELECT region, product, COUNT(*) FROM sales WHERE region IS NOT NULL GROUP BY region, product', sales),
      'region,product,col3', 'north,apple,1', 'south,pear,1', 'north,pear,1', 'east,apple,1', 'south,apple,1');
  });

  test('HAVING keeps the groups whose condition is TRUE', async () => {
    ok(await csv('SELECT region, COUNT(*) FROM sales GROUP BY region HAVING COUNT(*) > 1', sales), 'region,col2', 'north,2', 'south,2');
  });

  test('HAVING drops a group whose condition is NULL', async () => {
    ok(await csv('SELECT product FROM t GROUP BY product HAVING SUM(qty) > 0', { tables: { t: lines('product:text,qty:integer', 'a,3', 'b,', 'c,1', 'b,') } }),
      'product', 'a', 'c');
  });

  test('HAVING without GROUP BY makes one group, which it may drop', async () => {
    ok(await csv('SELECT COUNT(*) FROM sales HAVING COUNT(*) > 10', sales), 'col1');
    ok(await csv('SELECT COUNT(*) FROM sales HAVING COUNT(*) > 1', sales), 'col1', '6');
  });

  test('an aggregate in ORDER BY makes the query grouped', async () => {
    ok(await csv('SELECT 1 FROM sales ORDER BY COUNT(*)', sales), 'col1', '1');
  });

  test('a grouped query may name a GROUP BY item, or a column inside one', async () => {
    ok(await csv("SELECT region || '!' FROM sales GROUP BY region", sales), 'col1', 'north!', 'south!', 'east!', '');
  });

  test('a SELECT item the same as a GROUP BY expression, case and spacing aside', async () => {
    ok(await csv('SELECT year( day ), COUNT(*) FROM sales GROUP BY YEAR(day)', sales), 'col1,col2', '2024,5', ',1');
    ok(await csv('SELECT qty+1 FROM sales WHERE qty < 3 GROUP BY qty + 1', sales), 'col1', '3', '2');
  });

  test('a column outside every GROUP BY item and aggregate is exit 5', async () => {
    fails(await query('SELECT region, product FROM sales GROUP BY region', sales), 5);
    fails(await query('SELECT qty FROM sales GROUP BY qty + 1', sales), 5);
    fails(await query('SELECT region FROM sales GROUP BY region HAVING qty > 1', sales), 5);
    fails(await query('SELECT region FROM sales GROUP BY region ORDER BY product', sales), 5);
  });

  test('a column without any aggregate beside one is exit 5', async () => fails(await query('SELECT region, COUNT(*) FROM sales', sales), 5));

  test('* in a grouped query is exit 5 unless every column is grouped', async () => {
    const tables = { t: lines('a:integer,b:text', '1,x', '1,x', '2,y') };
    ok(await csv('SELECT * FROM t GROUP BY a, b', { tables }), 'a,b', '1,x', '2,y');
    fails(await query('SELECT * FROM t GROUP BY a', { tables }), 5);
  });

  test('an aggregate is exit 5 in WHERE, in GROUP BY and inside another aggregate', async () => {
    fails(await query('SELECT region FROM sales WHERE COUNT(*) > 1', sales), 5);
    fails(await query('SELECT COUNT(*) FROM sales GROUP BY COUNT(*)', sales), 5);
    fails(await query('SELECT SUM(COUNT(*)) FROM sales', sales), 5);
  });

  test('GROUP BY an alias is exit 5', async () => fails(await query('SELECT region AS r FROM sales GROUP BY r', sales), 5));

  test('an alias cannot be used in HAVING', async () => fails(await query('SELECT region, COUNT(*) AS n FROM sales GROUP BY region HAVING n > 1', sales), 5));

  test('with DISTINCT, ORDER BY an aggregate that is not an item is exit 5', async () => {
    fails(await query('SELECT DISTINCT region FROM sales GROUP BY region ORDER BY COUNT(*)', sales), 5);
  });

  test('with DISTINCT, ORDER BY an aggregate that is an item', async () => {
    ok(await csv('SELECT DISTINCT region, COUNT(*) FROM sales WHERE region IS NOT NULL GROUP BY region ORDER BY COUNT(*) DESC, region', sales),
      'region,col2', 'north,2', 'south,2', 'east,1');
  });

  test('ORDER BY an aggregate alias in a grouped query', async () => {
    ok(await csv('SELECT region, SUM(qty) AS s FROM sales WHERE region IS NOT NULL GROUP BY region ORDER BY s DESC, region', sales),
      'region,s', 'east,5', 'north,5', 'south,1');
  });

  test('expressions over aggregates', async () => {
    ok(await csv('SELECT SUM(qty) * 2, COUNT(*) + 1, MAX(qty) - MIN(qty) FROM sales', sales), 'col1,col2,col3', '30,7,4');
  });

  test('MIN and MAX ignore NULLs whatever NULLs do in ORDER BY', async () => {
    ok(await csv('SELECT MIN(day), MAX(day) FROM sales WHERE region = \'south\'', sales), 'col1,col2', '2024-01-03,2024-01-03');
  });

  change('GROUP BY then ORDER BY puts the NULL group last', async () => {
    ok(await csv('SELECT region, COUNT(*) FROM sales GROUP BY region ORDER BY region', sales), 'region,col2', 'east,1', 'north,2', 'south,2', ',1');
  });

  change('ORDER BY an aggregate that is NULL for some groups puts them last', async () => {
    ok(await csv('SELECT product, SUM(qty) FROM sales GROUP BY product ORDER BY SUM(qty)', { tables: { sales: lines(
      'product:text,qty:integer', 'a,3', 'b,', 'c,1', 'b,') } }), 'product,col2', 'c,1', 'a,3', 'b,');
  });

  change('SUM of integer quotients is a decimal', async () => {
    ok(await csv('SELECT SUM(a / b) FROM t', { tables: { t: lines('a:integer,b:integer', '7,2', '1,2') } }), 'col1', '4.0');
  });

  change('AVG of integer quotients', async () => {
    ok(await csv('SELECT AVG(a / b), MAX(a / b) FROM t', { tables: { t: lines('a:integer,b:integer', '1,4', '1,2') } }), 'col1,col2', '0.375,0.5');
  });

  change('a division by zero inside an aggregate is a NULL it skips', async () => {
    ok(await csv('SELECT SUM(a / b), COUNT(a / b) FROM t', { tables: { t: lines('a:integer,b:integer', '3,0', '3,2') } }), 'col1,col2', '1.5,1');
  });
});
