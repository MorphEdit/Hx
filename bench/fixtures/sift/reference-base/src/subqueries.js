// Subqueries: `(<select>)` as a value and `x IN (<select>)`. Each is checked with its own scope (it cannot see the
// query around it) and run once, before its statement: its run is a step of `env.before`, the steps kept in the order
// the subqueries end in the text, which is the order they start in with a subquery's own subqueries first.
import { checkError, runtimeError } from './errors.js';
import { compile, comparable, comparer, inValues } from './expr.js';
import { planSelect } from './select.js';

/**
 * Plan `node.select` as a subquery of one column and add its run to the steps before the statement: `{ type, values }`,
 * `values` filled with the column's values when the step runs, then passed to `check`.
 */
function plan(node, cx, what, check = () => {}) {
  const p = planSelect(node.select, cx.env);
  if (p.columns.length !== 1) throw checkError(`${what} must give one column, not ${p.columns.length}`);
  const sub = { type: p.types[0], values: [] };
  const step = (rt) => {
    sub.values = p.run(rt).map((r) => r[0]);
    check(sub.values);
  };
  step.at = node.t1;
  const before = cx.env.before;
  before.push(step);
  before.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return sub;
}

/** A scalar subquery, compiled in `cx`: `{ type, ev }`. */
export function compileScalarSubquery(node, cx) {
  const sub = plan(node, cx, 'a scalar subquery', (values) => {
    if (values.length > 1) throw runtimeError(`a scalar subquery gave ${values.length} rows`);
  });
  return { type: sub.type, ev: () => (sub.values.length === 0 ? null : sub.values[0]) };
}

/** `x [NOT] IN (<select>)`, compiled in `cx`: `{ type: 'boolean', ev }`. */
export function compileInSubquery(node, cx) {
  const e = compile(node.e, cx);
  const sub = plan(node, cx, 'IN (<select>)');
  if (!comparable(e.type, sub.type)) throw checkError(`IN cannot compare ${e.type ?? 'NULL'} with ${sub.type ?? 'NULL'}`);
  const cmp = comparer(e.type, sub.type);
  return { type: 'boolean', ev: (row, rt) => {
    const a = e.ev(row, rt);
    const v = inValues(sub.values.map(() => cmp), a, sub.values);
    return v === null ? null : v !== node.not;
  } };
}
