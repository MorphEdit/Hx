// UNION and UNION ALL, new with the change: rows, columns and types, ORDER BY / LIMIT over the whole union, and
// unions where a SELECT may stand.
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMERS, ORDERS, change, csv, fails, lines, ok, query, read } from './helpers.mjs';

const tu = { tables: { t: lines('a:integer,b:text', '1,x', '2,y', '2,y', ','), u: lines('a:integer,b:text', '2,y', '3,z', ',', '1,X') } };
const both = { tables: { customers: CUSTOMERS, orders: ORDERS } };

describe('union', { concurrency: true }, () => {
  change('UNION ALL gives the rows of the first SELECT, then those of the second', async () => {
    ok(await csv('SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT 2'), 'col1', '1', '1', '2');
    ok(await csv('SELECT a, b FROM t UNION ALL SELECT a, b FROM u', tu), 'a,b', '1,x', '2,y', '2,y', ',', '2,y', '3,z', ',', '1,X');
  });

  change('UNION keeps the first of every set of equal rows, NULL equal to NULL, case exact', async () => {
    ok(await csv('SELECT a, b FROM t UNION SELECT a, b FROM u', tu), 'a,b', '1,x', '2,y', ',', '3,z', '1,X');
  });

  change('UNION removes the duplicates of the first SELECT too', async () => {
    ok(await csv('SELECT a FROM t UNION SELECT 5', tu), 'a', '1', '2', '', '5');
  });

  change('UNION compares texts exactly', async () => ok(await csv("SELECT 'a' UNION SELECT 'A' UNION SELECT 'a'"), 'col1', 'a', 'A'));

  change('a chain is worked out left to right', async () => {
    ok(await csv('SELECT 1 UNION SELECT 1 UNION ALL SELECT 1'), 'col1', '1', '1');
    ok(await csv('SELECT 1 UNION ALL SELECT 1 UNION SELECT 2'), 'col1', '1', '2');
  });

  change('every SELECT of a union gives the same number of columns', async () => {
    fails(await query('SELECT 1, 2 UNION SELECT 3'), 5);
    fails(await query('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3, 4'), 5);
  });

  change('the columns at one position have one type', async () => {
    fails(await query("SELECT 1 UNION SELECT 'a'"), 5);
    fails(await query('SELECT TRUE UNION ALL SELECT 1'), 5);
    fails(await query("SELECT CAST('2024-01-01' AS DATE) UNION SELECT '2024-01-02'"), 5);
  });

  change('integers and decimals at one position make a decimal column', async () => {
    ok(await csv('SELECT 1 UNION ALL SELECT 2.5 UNION ALL SELECT 3'), 'col1', '1.0', '2.5', '3.0');
    ok(await csv('SELECT 1 UNION SELECT 1.0'), 'col1', '1.0');
  });

  change('a bare NULL is allowed at any position', async () => {
    ok(await csv("SELECT NULL, 1 UNION ALL SELECT 'a', NULL"), 'col1,col2', ',1', 'a,');
  });

  change('the result\'s column names are the first SELECT\'s', async () => {
    ok(await csv('SELECT 1 AS x, 2 AS y UNION SELECT 3 AS p, 4'), 'x,y', '1,2', '3,4');
  });

  change('ORDER BY, LIMIT and OFFSET after the last SELECT apply to the whole union', async () => {
    ok(await csv('SELECT 2 AS n UNION ALL SELECT 1 UNION ALL SELECT 3 ORDER BY n DESC'), 'n', '3', '2', '1');
    ok(await csv('SELECT 2 AS n UNION ALL SELECT 1 UNION ALL SELECT 3 ORDER BY n LIMIT 2 OFFSET 1'), 'n', '2', '3');
    ok(await csv('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 LIMIT 2'), 'col1', '1', '2');
  });

  change('ORDER BY a position of the union', async () => {
    ok(await csv("SELECT 'b' AS s, 1 AS n UNION ALL SELECT 'a', 2 ORDER BY 1"), 's,n', 'a,2', 'b,1');
  });

  change('ORDER BY of a union puts NULLs last, first when descending', async () => {
    ok(await csv('SELECT a FROM t UNION SELECT a FROM u ORDER BY a', tu), 'a', '1', '2', '3', '');
    ok(await csv('SELECT a AS k FROM t UNION SELECT a FROM u ORDER BY k DESC', tu), 'k', '', '3', '2', '1');
  });

  change('ORDER BY of a union takes only result column names and positions', async () => {
    fails(await query('SELECT 1 AS n UNION SELECT 2 ORDER BY n + 1'), 5);
    fails(await query('SELECT 1 AS n UNION SELECT 2 AS m ORDER BY m'), 5);
    fails(await query('SELECT a FROM t UNION SELECT a FROM u ORDER BY b', tu), 5);
    fails(await query('SELECT 1 AS n UNION SELECT 2 ORDER BY 2'), 5);
  });

  change('each SELECT of a union may have DISTINCT, WHERE, GROUP BY and HAVING', async () => {
    ok(await csv('SELECT DISTINCT a FROM t WHERE a > 1 UNION ALL SELECT COUNT(*) FROM u GROUP BY b HAVING COUNT(*) > 0', tu), 'a', '2', '1', '1', '1', '1');
  });

  change('a union of * and of joins', async () => {
    ok(await csv('SELECT * FROM t WHERE a = 1 UNION ALL SELECT * FROM u WHERE a = 3', tu), 'a,b', '1,x', '3,z');
    ok(await csv('SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id UNION SELECT name FROM customers WHERE city IS NULL', both),
      'name', 'Ann', 'Bob', 'Cy');
  });

  change('a union as a scalar subquery', async () => {
    ok(await csv('SELECT (SELECT 1 UNION SELECT 1)'), 'col1', '1');
    fails(await query('SELECT (SELECT 1 UNION ALL SELECT 1)'), 6);
  });

  change('a union in IN (<select>)', async () => {
    ok(await csv('SELECT id FROM customers WHERE id IN (SELECT 1 UNION SELECT 3)', both), 'id', '1', '3');
    ok(await csv('SELECT id FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE customer_id IS NOT NULL UNION ALL SELECT 4)', both), 'id', '3');
  });

  change('a union in INSERT … SELECT', async () => {
    const r = await query('INSERT INTO t (a) SELECT a FROM u WHERE a = 3 UNION ALL SELECT 9', tu);
    ok(r, 'inserted 2');
    assert.equal(read(r.dir, 'db/t.csv'), lines('a:integer,b:text', '1,x', '2,y', '2,y', ',', '3,', '9,'));
  });

  change('a missing table in a later SELECT of a union is exit 4', async () => {
    fails(await query('SELECT a FROM t UNION SELECT a FROM missing', tu), 4);
  });

  change('a union of integers and decimals is a decimal column in the table format', async () => {
    ok(await query('SELECT 1 AS n UNION ALL SELECT 10.5'), '   n', '----', ' 1.0', '10.5', '(2 rows)');
  });
});
