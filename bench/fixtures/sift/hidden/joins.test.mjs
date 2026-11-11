// Joins: inner and left, left to right, their row order, and the names they make known.
import { describe, test } from 'node:test';
import { CUSTOMERS, ORDERS, change, csv, fails, lines, ok, query } from './helpers.mjs';

const both = { tables: { customers: CUSTOMERS, orders: ORDERS } };

describe('joins', { concurrency: true }, () => {
  test('an inner join: for each left row in order, the matching right rows in file order', async () => {
    ok(await csv('SELECT c.name, o.id FROM customers c JOIN orders o ON o.customer_id = c.id', both), 'name,id', 'Ann,10', 'Ann,12', 'Bob,11');
  });

  test('INNER JOIN is JOIN', async () => {
    ok(await csv('SELECT c.name, o.id FROM customers AS c INNER JOIN orders AS o ON o.customer_id = c.id', both), 'name,id', 'Ann,10', 'Ann,12', 'Bob,11');
  });

  test('a left join keeps a left row with no match, with NULLs for the right table', async () => {
    ok(await csv('SELECT c.name, o.id FROM customers c LEFT JOIN orders o ON o.customer_id = c.id', both),
      'name,id', 'Ann,10', 'Ann,12', 'Bob,11', 'Cy,', 'Dee,');
  });

  test('LEFT OUTER JOIN is LEFT JOIN', async () => {
    ok(await csv('SELECT c.name, o.id FROM customers c LEFT OUTER JOIN orders o ON o.customer_id = c.id', both),
      'name,id', 'Ann,10', 'Ann,12', 'Bob,11', 'Cy,', 'Dee,');
  });

  test('tables without aliases are known by their names', async () => {
    ok(await csv('SELECT customers.name, orders.amount FROM customers JOIN orders ON orders.customer_id = customers.id', both),
      'name,amount', 'Ann,20.5', 'Ann,7.25', 'Bob,5.0');
  });

  test('* gives the columns of every table in FROM order', async () => {
    ok(await csv('SELECT * FROM customers JOIN orders ON orders.customer_id = customers.id WHERE orders.id = 11', both),
      'id,name,city,id,customer_id,amount,placed', '2,Bob,Rome,11,2,5.0,2024-01-03');
  });

  test('* of a left join without a match has NULLs in the right columns', async () => {
    ok(await csv('SELECT * FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id = 3', both),
      'id,name,city,id,customer_id,amount,placed', '3,Cy,,,,,');
  });

  test('<alias>.* in a join gives that table only', async () => {
    ok(await csv('SELECT o.*, c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.id = 2', both),
      'id,customer_id,amount,placed,name', '11,2,5.0,2024-01-03,Bob');
  });

  test('a column name alone is fine when one table has it', async () => {
    ok(await csv('SELECT name, amount FROM customers JOIN orders ON customer_id = customers.id WHERE amount < 6', both), 'name,amount', 'Bob,5.0');
  });

  test('a column name more than one table has is ambiguous', async () => {
    fails(await query('SELECT id FROM customers JOIN orders ON TRUE', both), 5);
  });

  test('a self-join without aliases is exit 5', async () => {
    fails(await query('SELECT 1 FROM customers JOIN customers ON TRUE', both), 5);
  });

  test('two equal aliases are exit 5', async () => {
    fails(await query('SELECT 1 FROM customers x JOIN orders x ON TRUE', both), 5);
  });

  test('an alias equal to another table\'s name is exit 5', async () => {
    fails(await query('SELECT 1 FROM customers JOIN orders customers ON TRUE', both), 5);
  });

  test('a self-join with aliases', async () => {
    ok(await csv('SELECT a.name, b.name FROM customers a JOIN customers b ON a.city = b.city AND a.id < b.id', both), 'name,name', 'Ann,Dee');
  });

  test('a table aliased in a join is known by its alias only', async () => {
    fails(await query('SELECT orders.id FROM customers c JOIN orders o ON o.customer_id = c.id', both), 5);
  });

  test('ON may not name a table joined after it', async () => {
    const tables = { a: lines('k:integer', '1'), b: lines('k:integer', '1'), c: lines('k:integer', '1') };
    fails(await query('SELECT 1 FROM a JOIN b ON b.k = c.k JOIN c ON TRUE', { tables }), 5);
  });

  test('ON may name every table joined so far', async () => {
    const tables = { a: lines('k:integer', '1', '2'), b: lines('k:integer,v:text', '1,x', '2,y'), c: lines('k:integer,w:text', '2,z', '1,q') };
    ok(await csv('SELECT a.k, b.v, c.w FROM a JOIN b ON b.k = a.k JOIN c ON c.k = a.k AND c.k = b.k', { tables }), 'k,v,w', '1,x,q', '2,y,z');
  });

  test('ON takes a boolean', async () => fails(await query('SELECT 1 FROM customers c JOIN orders o ON o.id', both), 5));

  test('an ON condition that is NULL does not match', async () => {
    ok(await csv('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id', both), 'id', '10', '11', '12');
  });

  test('a left join with WHERE on the right side finds the rows without a match', async () => {
    ok(await csv('SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL', both), 'name', 'Cy', 'Dee');
  });

  test('joins are made left to right', async () => {
    const tables = { a: lines('k:integer', '1', '2'), b: lines('k:integer', '1', '2'), c: lines('k:integer,v:text', '2,x') };
    ok(await csv('SELECT a.k, c.v FROM a JOIN b ON b.k = a.k LEFT JOIN c ON c.k = b.k', { tables }), 'k,v', '1,', '2,x');
  });

  test('a join with ON TRUE pairs every row', async () => {
    ok(await csv('SELECT COUNT(*) FROM customers JOIN orders ON TRUE', both), 'col1', '20');
    ok(await csv('SELECT c.id, o.id FROM customers c JOIN orders o ON TRUE WHERE c.id < 3 AND o.id < 12', both),
      'id,id', '1,10', '1,11', '2,10', '2,11');
  });

  test('a left join with an empty right table', async () => {
    ok(await csv('SELECT c.id, e.x FROM customers c LEFT JOIN e ON TRUE', { tables: { customers: CUSTOMERS, e: lines('x:text') } }),
      'id,x', '1,', '2,', '3,', '4,');
  });

  test('an inner join with an empty right table gives no rows', async () => {
    ok(await csv('SELECT c.id FROM customers c JOIN e ON TRUE', { tables: { customers: CUSTOMERS, e: lines('x:text') } }), 'id');
  });

  test('a join with grouping', async () => {
    ok(await csv('SELECT c.name, COUNT(o.id), SUM(o.amount) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name', both),
      'name,col2,col3', 'Ann,2,27.75', 'Bob,1,5.0', 'Cy,0,', 'Dee,0,');
  });

  test('a join of a missing table is exit 4', async () => {
    fails(await query('SELECT 1 FROM customers JOIN missing ON TRUE', both), 4);
  });

  test('a join compares a date column with a text', async () => {
    const tables = { d: lines('day:date', '2024-01-03'), t: lines('s:text', '2024-01-03', '2024-01-04') };
    ok(await csv('SELECT d.day, t.s FROM d JOIN t ON d.day = t.s', { tables }), 'day,s', '2024-01-03,2024-01-03');
  });

  change('a left join sorted by a right column puts its NULLs last', async () => {
    ok(await csv('SELECT c.name, o.amount FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ORDER BY o.amount', both),
      'name,amount', 'Bob,5.0', 'Ann,7.25', 'Ann,20.5', 'Cy,', 'Dee,');
  });

  change('a left join sorted descending puts its NULLs first', async () => {
    ok(await csv('SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id ORDER BY o.id DESC', both),
      'name', 'Cy', 'Dee', 'Ann', 'Bob', 'Ann');
  });

  change('a join ON a quotient of integers', async () => {
    const tables = { a: lines('k:integer', '1', '2'), b: lines('v:decimal', '0.5', '1') };
    ok(await csv('SELECT a.k, b.v FROM a JOIN b ON b.v = a.k / 2', { tables }), 'k,v', '1,0.5', '2,1.0');
  });
});
