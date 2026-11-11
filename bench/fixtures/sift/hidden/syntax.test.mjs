// The lexer and the parser: words, literals, comments, precedence, and syntax errors at their line and column.
import { describe, test } from 'node:test';
import { change, csv, fails, ok, query, syntaxAt } from './helpers.mjs';

const at = async (sql, line, column) => syntaxAt(await query(sql), line, column);

describe('syntax', { concurrency: true }, () => {
  test('a character that is not a symbol is a syntax error at that character', () => at('SELECT 1 # 2', 1, 10));

  test('the first syntax error in the text is the one reported', () => at('SELECT # FROM @', 1, 8));

  test('a double quote is not a symbol: there are no quoted identifiers', () => at('SELECT "a"', 1, 8));

  test('columns count characters, not bytes', () => at("SELECT 'é' #", 1, 12));

  test('a tab is one column', () => at('SELECT\t#', 1, 8));

  test('a \\r alone is whitespace, not a line break', () => at('SELECT 1\r#', 1, 10));

  test('a comment to the end of the line counts its line', () => at('-- c\nSELECT @', 2, 8));

  test('a /* */ comment may span lines, and its lines count', () => at('/* a\nb */ SELECT ?', 2, 13));

  test('a text literal may span lines, and its lines count', () => at("SELECT 'a\nb' $", 2, 4));

  test('the end of the input is just after its last character', () => at('SELECT 1 +', 1, 11));

  test('the end of an input ending with \\n is column 1 of the next line', () => at('SELECT 1 +\n', 2, 1));

  test('\\r\\n is one line break', () => at('SELECT\r\n1 +\r\n', 3, 1));

  test('an input of spaces only is a syntax error at its end', () => at('   ', 1, 4));

  test('an input of a comment only is a syntax error at its end', () => at('-- only\n', 2, 1));

  test('an unclosed text literal is a syntax error at its opening quote', () => at("SELECT 'abc", 1, 8));

  test('an unclosed comment is a syntax error at its first character', () => at('SELECT 1 /* x', 1, 10));

  test('comments do not nest', () => at('SELECT /* a /* b */ 1 */', 1, 24));

  test('-- starts a comment, so --5 is not two minuses', () => at('SELECT --5', 1, 11));

  test('a missing closing parenthesis is reported at the end', () => at('SELECT (1 + 2', 1, 14));

  test('query takes one statement: a second one is a syntax error at its first token', () => at('SELECT 1; SELECT 2', 1, 11));

  test('query takes one ending ;, not two', () => at('SELECT 1;;', 1, 10));

  test('comparisons do not chain', () => at('SELECT 1 < 2 < 3', 1, 14));

  test('FROM a, b is a syntax error at the comma', () => at('SELECT * FROM a, b', 1, 16));

  test('clauses come in their order', () => at('SELECT * FROM t ORDER BY a WHERE a = 1', 1, 28));

  test('OFFSET needs a LIMIT before it', () => at('SELECT 1 OFFSET 1', 1, 10));

  test('LIMIT takes an integer literal, not a signed number', () => at('SELECT 1 LIMIT -1', 1, 16));

  test('LIMIT takes an integer literal, not a name', () => at('SELECT 1 LIMIT x', 1, 16));

  test('LIMIT takes an integer literal, not a decimal', () => at('SELECT 1 FROM t LIMIT 1.5', 1, 23));

  test('a reserved word is not an alias', () => at('SELECT 1 AS select', 1, 13));

  test('IF is reserved', () => at('SELECT 1 AS if', 1, 13));

  test('a reserved word is not a table name', () => at('SELECT * FROM order', 1, 15));

  test('a reserved word is not a table alias', () => at('SELECT 1 FROM t AS select', 1, 20));

  test('a number is not an alias', () => at('SELECT 1 1', 1, 10));

  test('IS takes NULL or NOT NULL', () => at('SELECT 1 IS 1', 1, 13));

  test('an IN list has at least one expression', () => at('SELECT 1 IN ()', 1, 14));

  test('a column reference has at most one dot', () => at('SELECT a.b.c', 1, 11));

  test('NULLS takes FIRST or LAST', () => at('SELECT 1 ORDER BY 1 NULLS', 1, 26));

  test('a JOIN needs its ON', () => at('SELECT 1 FROM t JOIN u', 1, 23));

  test('SELECT needs at least one item', () => at('SELECT FROM t', 1, 8));

  test('an unknown statement is a syntax error at its first word', () => at('TRUNCATE t', 1, 1));

  test('DELETE needs FROM', () => at('DELETE t', 1, 8));

  test('DROP TABLE takes one table', () => at('DROP TABLE t u', 1, 14));

  test('UPDATE … WHERE needs its condition', () => at('UPDATE t SET a = 1 WHERE', 1, 25));

  test('INSERT … VALUES needs its rows', () => at('INSERT INTO t VALUES', 1, 21));

  test('a VALUES row has at least one expression', () => at('INSERT INTO t VALUES ()', 1, 23));

  test('CREATE TABLE has at least one column', () => at('CREATE TABLE t ()', 1, 17));

  test('CREATE TABLE has no trailing comma', () => at('CREATE TABLE t (a INTEGER,)', 1, 27));

  test('CREATE TABLE takes the five type names only', () => at('CREATE TABLE t (a money)', 1, 19));

  test('CAST takes the five type names only', () => at('SELECT CAST(1 AS money)', 1, 18));

  test('an integer literal outside the integer range is a syntax error', () => at('SELECT 9223372036854775808', 1, 8));

  test('the largest integer literal is read', async () => ok(await csv('SELECT 9223372036854775807'), 'col1', '9223372036854775807'));

  test('a decimal literal with 7 digits after the point is a syntax error', () => at('SELECT 1.1234567', 1, 8));

  test('a decimal literal with 19 digits before the point is a syntax error', () => at('SELECT 1234567890123456789.5', 1, 8));

  test('a decimal literal with 18 digits before the point and 6 after is read', async () => {
    ok(await csv('SELECT 123456789012345678.5, 0.123456'), 'col1,col2', '123456789012345678.5,0.123456');
  });

  test('a point with no digit before it is a syntax error', () => at('SELECT .5', 1, 8));

  test('a point with no digit after it is a syntax error', async () => fails(await query('SELECT 5.'), 3));

  test('there are no signed literals: -5 is the minus operator on 5', async () => {
    ok(await csv('SELECT -5, - 5, -(2 + 3), 1 - -1'), 'col1,col2,col3,col4', '-5,-5,-5,2');
  });

  test("a text literal writes one ' as ''", async () => ok(await csv("SELECT 'it''s', ''''"), 'col1,col2', "it's,'"));

  test('a text literal keeps its line breaks', async () => ok(await csv("SELECT 'a\nb'"), 'col1', '"a\nb"'));

  test('; and -- inside a text literal are text', async () => ok(await csv("SELECT ';', '-- x', '/* y */'"), 'col1,col2,col3', ';,-- x,/* y */'));

  test('comments and whitespace may stand anywhere between tokens', async () => {
    ok(await csv('/* lead */ SELECT -- x\n\t1 /* y */ AS /* z */ a\r\n;'), 'a', '1');
  });

  test('a statement may end with one ;', async () => ok(await csv('SELECT 1 ;  -- done'), 'col1', '1'));

  test('reserved words are read in any case', async () => ok(await csv('sElEcT 1 aS x wHeRe tRuE'), 'x', '1'));

  test('identifiers are read in any case and shown in small letters', async () => ok(await csv('SELECT 1 AS MyName, 2 AS _X9'), 'myname,_x9', '1,2'));

  test('type names, FIRST, LAST and function names are not reserved', async () => {
    ok(await csv('SELECT 1 AS text, 2 AS date, 3 AS first, 4 AS last, 5 AS length, 6 AS integer, 7 AS today'),
      'text,date,first,last,length,integer,today', '1,2,3,4,5,6,7');
  });

  test('precedence: NOT is looser than a comparison, AND tighter than OR', async () => {
    ok(await csv('SELECT NOT 1 = 2, TRUE OR FALSE AND FALSE, NOT FALSE AND FALSE, NOT TRUE OR TRUE'), 'col1,col2,col3,col4', 'true,true,false,true');
  });

  test('precedence: * / % bind tighter than + - ||, each level left to right', async () => {
    ok(await csv("SELECT 2 + 3 * 4, (2 + 3) * 4, 10 - 4 - 3, 10 % 4 * 3, 2 * 3 % 4, 1 + 2 || 'x', -2 * 3"),
      'col1,col2,col3,col4,col5,col6,col7', '14,20,3,6,2,3x,-6');
  });

  test("precedence: || and + are one level, so 'a' || 1 + 2 adds to a text", async () => fails(await query("SELECT 'a' || 1 + 2"), 5));

  test('BETWEEN takes its own AND before the AND operator', async () => {
    ok(await csv('SELECT 1 BETWEEN 0 AND 2 AND TRUE, 5 NOT BETWEEN 0 AND 2 AND FALSE'), 'col1,col2', 'true,false');
  });

  test('!= is <>', async () => ok(await csv('SELECT 1 != 2, 1 != 1, 1 <> 2'), 'col1,col2,col3', 'true,false,true'));

  test('the NOT forms of IN, LIKE, BETWEEN and IS NULL parse', async () => {
    ok(await csv("SELECT 1 NOT IN (2), 'a' NOT LIKE 'b', 1 NOT BETWEEN 2 AND 3, 1 IS NOT NULL"), 'col1,col2,col3,col4', 'true,true,true,true');
  });

  change('a SELECT of a union other than the last cannot have ORDER BY', () => at('SELECT 1 ORDER BY 1 UNION SELECT 2', 1, 10));

  change('a SELECT of a union other than the last cannot have LIMIT', () => at('SELECT 1 LIMIT 1 UNION SELECT 2', 1, 10));
});
