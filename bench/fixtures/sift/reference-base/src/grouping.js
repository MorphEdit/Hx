// Grouping and aggregates: GROUP BY, HAVING and COUNT, SUM, AVG, MIN, MAX. Not built yet: a sibling issue of PRD #446
// builds them here.
import { checkError } from './errors.js';

/**
 * A grouped query (select.js decides that it is one): its result items and ORDER BY keys worked out per group.
 * Returns `{ items: [{ type }], run(rows, rt) }`, `run` taking the rows WHERE kept and giving `[{ vals, keys }]`, one
 * per group in group order.
 */
export function planGrouped(sel, scope, items, order, env) {
  void sel;
  void scope;
  void items;
  void order;
  void env;
  throw checkError('GROUP BY, HAVING and aggregates are not supported yet');
}
