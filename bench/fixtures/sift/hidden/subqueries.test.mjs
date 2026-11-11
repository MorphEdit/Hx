// Subqueries: scalar and IN, what they may name, and that each runs once before its statement.
import { describe, test } from 'node:test';
import { CUSTOMERS, ORDERS, change, csv, fails, fileErrorAt, lines, ok, query } from './helpers.mjs';

const both = { tables: { customers: CUSTOMERS, orders: ORDERS } };

describe('subqueries', { concurrency: true }, () => {
  test('a scalar subquery is the value in its one row', async () => {
    ok(await csv('SELECT (SELECT MAX(amount) FROM orders)', both), 'col1', '20.5');
  });

  test('a scalar subquery with no rows is NULL', async () => {
    ok(await csv('SELECT (SELECT id FROM orders WHERE FALSE) IS NULL, (SELECT id FROM orders WHERE FALSE)', both), 'col1,col2', 'true,');
  });

  test('a scalar subquery must give one column', async () => {
    fails(await query('SELECT (SELECT id, amount FROM orders WHERE id = 10)', both), 5);
  });

  test('a scalar subquery with more than one row is a run-time error', async () => {
    fails(await query('SELECT (SELECT id FROM orders)', both), 6);
  });

  test('a scalar subquery has the type of its column', async () => {
    ok(await csv('SELECT (SELECT 1) + 1, (SELECT placed FROM orders WHERE id = 10) + 1', both), 'col1,col2', '2,2024-01-03');
    fails(await query("SELECT (SELECT 'a') + 1"), 5);
  });

  test('a scalar subquery in WHERE', async () => {
    ok(await csv('SELECT id FROM orders WHERE amount > (SELECT AVG(amount) FROM orders)', both), 'id', '10');
  });

  test('a scalar subquery with an alias names its column', async () => {
    ok(await csv('SELECT (SELECT 1) AS one'), 'one', '1');
  });

  test('subqueries nest', async () => ok(await csv('SELECT (SELECT (SELECT 5) + 1)'), 'col1', '6'));

  test('a subquery may have ORDER BY and LIMIT', async () => {
    ok(await csv('SELECT (SELECT name FROM customers ORDER BY name DESC LIMIT 1)', both), 'col1', 'Dee');
    ok(await csv('SELECT (SELECT name FROM customers ORDER BY id LIMIT 1 OFFSET 2)', both), 'col1', 'Cy');
  });

  test('IN (<select>) compares with the subquery\'s values', async () => {
    ok(await csv('SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders)', both), 'name', 'Ann', 'Bob');
  });

  test('NOT IN (<select>) with a NULL among the values is never TRUE', async () => {
    ok(await csv('SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders)', both), 'name');
  });

  test('NOT IN (<select>) without NULLs', async () => {
    ok(await csv('SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE customer_id IS NOT NULL)', both), 'name', 'Cy', 'Dee');
  });

  test('IN (<select>) of no rows is FALSE, NOT IN TRUE', async () => {
    ok(await csv('SELECT 1 IN (SELECT id FROM customers WHERE FALSE), 1 NOT IN (SELECT id FROM customers WHERE FALSE)', both), 'col1,col2', 'false,true');
  });

  test('IN (<select>) follows the NULL rules of IN', async () => {
    ok(await csv('SELECT NULL IN (SELECT id FROM customers), 9 IN (SELECT customer_id FROM orders), 3 IN (SELECT customer_id FROM orders)', both),
      'col1,col2,col3', ',true,');
  });

  test('IN (<select>) must have one column', async () => {
    fails(await query('SELECT 1 IN (SELECT id, name FROM customers)', both), 5);
  });

  test('IN (<select>) of another type is a type error', async () => {
    fails(await query('SELECT 1 IN (SELECT name FROM customers)', both), 5);
  });

  test('IN (<select>) with grouping inside', async () => {
    ok(await csv('SELECT name FROM customers WHERE id IN (SELECT customer_id FROM orders GROUP BY customer_id HAVING COUNT(*) > 1)', both), 'name', 'Ann');
  });

  test('a subquery cannot name a column of the query around it', async () => {
    fails(await query('SELECT name FROM customers WHERE id IN (SELECT id FROM orders WHERE customer_id = customers.id)', both), 5);
    fails(await query('SELECT (SELECT name) FROM customers', both), 5);
  });

  test('a subquery of a missing table is exit 4', async () => {
    fails(await query('SELECT (SELECT 1 FROM missing)', both), 4);
  });

  test('the tables of subqueries are checked in the order they appear in the text', async () => {
    const tables = { a: lines('x:integer', 'bad'), b: lines('x:integer', '1', 'bad') };
    fileErrorAt(await query('SELECT (SELECT x FROM a) FROM b', { tables }), 'a.csv', 2);
  });

  test('a subquery runs before its statement, even when no row would use it', async () => {
    fails(await query('SELECT 1 FROM customers WHERE FALSE AND id IN (SELECT CAST(name AS INTEGER) FROM customers)', both), 6);
    fails(await query('SELECT 1 FROM customers WHERE FALSE AND (SELECT id FROM customers) = 1', both), 6);
  });

  test('a subquery runs once: a scalar one gives the same value to every row', async () => {
    ok(await csv('SELECT id, (SELECT COUNT(*) FROM orders) FROM customers WHERE id < 3', both), 'id,col2', '1,5', '2,5');
  });

  test('a subquery in HAVING', async () => {
    ok(await csv('SELECT customer_id FROM orders GROUP BY customer_id HAVING COUNT(*) = (SELECT MAX(id) - 9 FROM orders WHERE id < 12)', both),
      'customer_id', '1');
  });

  test('a subquery with DISTINCT', async () => {
    ok(await csv("SELECT (SELECT DISTINCT city FROM customers WHERE city = 'Oslo')", both), 'col1', 'Oslo');
  });

  change('a scalar subquery of a division by zero is NULL', async () => {
    ok(await csv('SELECT (SELECT 1 / 0) IS NULL, (SELECT 7 / 2)'), 'col1,col2', 'true,3.5');
  });

  change('a subquery with ORDER BY puts NULLs last', async () => {
    ok(await csv('SELECT (SELECT customer_id FROM orders ORDER BY customer_id DESC LIMIT 1) IS NULL, (SELECT city FROM customers ORDER BY city LIMIT 1 OFFSET 3) IS NULL', both),
      'col1,col2', 'true,true');
  });
});
