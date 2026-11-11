// SELECT: items, aliases and result names, *, WHERE, DISTINCT, ORDER BY (NULLs included), LIMIT/OFFSET, row order,
// and when things are worked out.
import { describe, test } from 'node:test';
import { FRUIT, change, csv, fails, lines, ok, query } from './helpers.mjs';

const fruit = { tables: { fruit: FRUIT } };
const P = lines('k:integer,v:text', '2,a', '1,b', '2,c', '1,d');
const p = { tables: { p: P } };

describe('select', { concurrency: true }, () => {
  test('the items of each row in file order', async () => {
    ok(await csv('SELECT name, price FROM fruit', fruit), 'name,price', 'apple,1.5', '"pear, green",0.25', '"",12.0', ',');
  });

  test('an alias names its column, with or without AS', async () => {
    ok(await csv('SELECT name AS n, price p, id + 1 AS next FROM fruit WHERE id = 1', fruit), 'n,p,next', 'apple,1.5,2');
  });

  test('a column without alias or name is col<n>, n its position', async () => {
    ok(await csv('SELECT id, 1 + 2, name, id * 2 FROM fruit WHERE id = 1', fruit), 'id,col2,name,col4', '1,3,apple,2');
  });

  test('two result columns may have the same name', async () => {
    ok(await csv('SELECT id, id, name AS id FROM fruit WHERE id = 1', fruit), 'id,id,id', '1,1,apple');
  });

  test('a qualified column is named by its column', async () => {
    ok(await csv('SELECT fruit.name FROM fruit WHERE fruit.id = 2', fruit), 'name', '"pear, green"');
  });

  test('a SELECT without FROM gives one row', async () => {
    ok(await csv("SELECT 1, 'a', NULL"), 'col1,col2,col3', '1,a,');
  });

  test('* without FROM is exit 5', async () => fails(await query('SELECT *'), 5));

  test('* gives every column, and counts in the positions of later items', async () => {
    ok(await csv('SELECT *, id FROM fruit WHERE id = 1', fruit), 'id,name,price,in_stock,added,id', '1,apple,1.5,true,2024-01-05,1');
  });

  test('<alias>.* gives the columns of that table', async () => {
    ok(await csv('SELECT f.*, 0 FROM fruit f WHERE f.id = 3', fruit), 'id,name,price,in_stock,added,col6', '3,"",12.0,true,2023-12-31,0');
  });

  test('a table with an alias is known by its alias only', async () => fails(await query('SELECT fruit.id FROM fruit f', fruit), 5));

  test('an unknown column is exit 5', async () => fails(await query('SELECT colour FROM fruit', fruit), 5));

  test('an unknown table qualifier is exit 5', async () => fails(await query('SELECT x.id FROM fruit', fruit), 5));

  test('table and column names are read in any case', async () => {
    ok(await csv('SELECT NAME, Fruit.ID FROM FRUIT WHERE ID = 1', fruit), 'name,id', 'apple,1');
  });

  test('WHERE keeps the rows whose condition is TRUE, in their order', async () => {
    ok(await csv('SELECT id FROM fruit WHERE in_stock', fruit), 'id', '1', '3');
    ok(await csv('SELECT id FROM fruit WHERE NOT in_stock', fruit), 'id', '2');
  });

  test('WHERE drops the rows whose condition is NULL', async () => {
    ok(await csv('SELECT id FROM fruit WHERE price > 1', fruit), 'id', '1', '3');
  });

  test('WHERE with IS NULL', async () => ok(await csv('SELECT id FROM fruit WHERE added IS NULL', fruit), 'id', '2', '4'));

  test('an alias cannot be used in WHERE', async () => fails(await query('SELECT id AS k FROM fruit WHERE k = 1', fruit), 5));

  test('DISTINCT keeps the first of equal rows, all NULLs equal, case exact', async () => {
    ok(await csv('SELECT DISTINCT c FROM t', { tables: { t: 'c:text\nred\nblue\nRed\nred\n\n\n' } }), 'c', 'red', 'blue', 'Red', '');
  });

  test('DISTINCT compares whole rows', async () => {
    const tables = { t: lines('a:integer,b:text', '1,x', '2,x', '1,x', '1,y') };
    ok(await csv('SELECT DISTINCT a, b FROM t', { tables }), 'a,b', '1,x', '2,x', '1,y');
    ok(await csv('SELECT DISTINCT b FROM t', { tables }), 'b', 'x', 'y');
  });

  test('DISTINCT compares decimals by value', async () => {
    ok(await csv('SELECT DISTINCT a FROM t', { tables: { t: lines('a:decimal', '1', '1.0', '1.00', '2') } }), 'a', '1.0', '2.0');
  });

  test('ORDER BY sorts stably, ascending unless DESC', async () => {
    ok(await csv('SELECT k, v FROM p ORDER BY k', p), 'k,v', '1,b', '1,d', '2,a', '2,c');
    ok(await csv('SELECT k, v FROM p ORDER BY k DESC', p), 'k,v', '2,a', '2,c', '1,b', '1,d');
  });

  test('ORDER BY sorts by its items in turn', async () => {
    ok(await csv('SELECT k, v FROM p ORDER BY k DESC, v DESC', p), 'k,v', '2,c', '2,a', '1,d', '1,b');
  });

  test('ORDER BY sorts texts by character codes', async () => {
    ok(await csv('SELECT v FROM t ORDER BY v', { tables: { t: lines('v:text', 'b', 'B', 'a', 'ab') } }), 'v', 'B', 'a', 'ab', 'b');
  });

  test('ORDER BY sorts false before true, and dates by time', async () => {
    ok(await csv('SELECT id FROM fruit WHERE id < 4 ORDER BY in_stock, added DESC', fruit), 'id', '2', '1', '3');
  });

  test('ORDER BY an expression that is not selected', async () => {
    ok(await csv('SELECT name FROM fruit WHERE id < 4 ORDER BY -id', fruit), 'name', '""', '"pear, green"', 'apple');
  });

  test('ORDER BY an alias means that item, even over a column of that name', async () => {
    ok(await csv('SELECT id AS price, name FROM fruit WHERE id < 4 ORDER BY price DESC', fruit), 'price,name', '3,""', '2,"pear, green"', '1,apple');
  });

  test('ORDER BY an alias two items have is ambiguous', async () => {
    fails(await query('SELECT id AS x, price AS x FROM fruit ORDER BY x', fruit), 5);
  });

  test('ORDER BY a position means that item', async () => {
    ok(await csv('SELECT name, id FROM fruit WHERE id < 4 ORDER BY 2 DESC', fruit), 'name,id', '"",3', '"pear, green",2', 'apple,1');
  });

  test('ORDER BY a position counts * as all its columns', async () => {
    ok(await csv('SELECT *, k * 10 FROM p ORDER BY 3 DESC, 2', p), 'k,v,col3', '2,a,20', '2,c,20', '1,b,10', '1,d,10');
  });

  test('ORDER BY position 0 or past the items is exit 5', async () => {
    fails(await query('SELECT k, v FROM p ORDER BY 0', p), 5);
    fails(await query('SELECT k, v FROM p ORDER BY 3', p), 5);
  });

  test('NULLS FIRST and NULLS LAST, whatever the direction', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY price NULLS FIRST', fruit), 'id', '4', '2', '1', '3');
    ok(await csv('SELECT id FROM fruit ORDER BY price ASC NULLS LAST', fruit), 'id', '2', '1', '3', '4');
    ok(await csv('SELECT id FROM fruit ORDER BY price DESC NULLS FIRST', fruit), 'id', '4', '3', '1', '2');
    ok(await csv('SELECT id FROM fruit ORDER BY price DESC NULLS LAST', fruit), 'id', '3', '1', '2', '4');
  });

  change('NULLs sort last when ascending', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY price', fruit), 'id', '2', '1', '3', '4');
    ok(await csv('SELECT id FROM fruit ORDER BY price ASC', fruit), 'id', '2', '1', '3', '4');
  });

  change('NULLs sort first when descending', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY price DESC', fruit), 'id', '4', '3', '1', '2');
  });

  change('a NULL text sorts after the empty text', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY name', fruit), 'id', '3', '1', '2', '4');
  });

  change('NULLs last in each ORDER BY item in turn', async () => {
    ok(await csv('SELECT a, b FROM t ORDER BY a, b DESC', { tables: { t: lines('a:integer,b:integer', '1,', '1,5', ',2', '2,1', ',1') } }),
      'a,b', '1,', '1,5', '2,1', ',2', ',1');
  });

  change('NULLs last by position', async () => {
    ok(await csv('SELECT added FROM fruit ORDER BY 1', fruit), 'added', '2023-12-31', '2024-01-05', '', '');
  });

  change('NULLs last before LIMIT cuts', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY price LIMIT 1', fruit), 'id', '2');
    ok(await csv('SELECT id FROM fruit ORDER BY added DESC LIMIT 2', fruit), 'id', '2', '4');
  });

  change('NULLs first in a descending DISTINCT', async () => {
    ok(await csv('SELECT DISTINCT in_stock FROM fruit ORDER BY in_stock DESC', fruit), 'in_stock', '', 'true', 'false');
  });

  change('NULLs of an expression sort last', async () => {
    ok(await csv('SELECT id FROM fruit ORDER BY LENGTH(name)', fruit), 'id', '3', '1', '2', '4');
  });

  test('LIMIT keeps the first rows after OFFSET skips some', async () => {
    ok(await csv('SELECT id FROM fruit LIMIT 2 OFFSET 1', fruit), 'id', '2', '3');
    ok(await csv('SELECT id FROM fruit LIMIT 10', fruit), 'id', '1', '2', '3', '4');
    ok(await csv('SELECT id FROM fruit LIMIT 2 OFFSET 0', fruit), 'id', '1', '2');
  });

  test('LIMIT 0 and an OFFSET past the end keep no row', async () => {
    ok(await csv('SELECT id FROM fruit LIMIT 0', fruit), 'id');
    ok(await csv('SELECT id FROM fruit LIMIT 2 OFFSET 4', fruit), 'id');
  });

  test('LIMIT cuts after ORDER BY', async () => {
    ok(await csv('SELECT id FROM fruit WHERE price IS NOT NULL ORDER BY price DESC LIMIT 2', fruit), 'id', '3', '1');
  });

  test('with DISTINCT, an ORDER BY item that is not a result column is exit 5', async () => {
    fails(await query('SELECT DISTINCT name FROM fruit ORDER BY id', fruit), 5);
  });

  test('with DISTINCT, ORDER BY the same expression as an item, an alias or a position', async () => {
    ok(await csv('SELECT DISTINCT k + 1 FROM p ORDER BY k + 1 DESC', p), 'col1', '3', '2');
    ok(await csv('SELECT DISTINCT v AS x FROM p ORDER BY x DESC', p), 'x', 'd', 'c', 'b', 'a');
    ok(await csv('SELECT DISTINCT k FROM p ORDER BY 1', p), 'k', '1', '2');
  });

  test('DISTINCT keeps the first of equal rows where it was, before ORDER BY sorts', async () => {
    ok(await csv('SELECT DISTINCT k FROM p', p), 'k', '2', '1');
  });

  test('a row that LIMIT drops is still worked out: its error is an error', async () => {
    fails(await query('SELECT CAST(s AS INTEGER) FROM t LIMIT 1', { tables: { t: lines('s:text', '5', 'x') } }), 6);
  });

  test('a row that WHERE drops never has its items worked out', async () => {
    ok(await csv("SELECT CAST(s AS INTEGER) FROM t WHERE s <> 'x'", { tables: { t: lines('s:text', '5', 'x') } }), 'col1', '5');
  });

  test('AND stops at a FALSE left side, OR at a TRUE one', async () => {
    ok(await csv("SELECT 1 WHERE FALSE AND CAST('x' AS INTEGER) = 1"), 'col1');
    ok(await csv("SELECT TRUE OR CAST('x' AS INTEGER) = 1, FALSE AND CAST('x' AS INTEGER) = 1"), 'col1,col2', 'true,false');
  });

  test('ORDER BY items are worked out for every row', async () => {
    fails(await query('SELECT s FROM t ORDER BY CAST(s AS INTEGER) LIMIT 1', { tables: { t: lines('s:text', '5', 'x') } }), 6);
  });
});
