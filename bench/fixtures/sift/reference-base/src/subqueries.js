// Subqueries: `(<select>)` as a value and `x IN (<select>)`. Not built yet: a sibling issue of PRD #446 builds them
// here. Each is checked with its own scope (it cannot see the query around it) and run once, before its statement.
import { checkError } from './errors.js';

/** A scalar subquery, compiled in `cx`: `{ type, ev }`. */
export function compileScalarSubquery(node, cx) {
  void node;
  void cx;
  throw checkError('subqueries are not supported yet');
}

/** `x [NOT] IN (<select>)`, compiled in `cx`: `{ type: 'boolean', ev }`. */
export function compileInSubquery(node, cx) {
  void node;
  void cx;
  throw checkError('subqueries are not supported yet');
}
