// Joins: `[INNER] JOIN` and `LEFT [OUTER] JOIN`, made left to right. Not built yet: a sibling issue of PRD #446
// builds them here. `planJoins` adds each joined table to the scope, checks its ON, and gives the joined rows.
import { checkError } from './errors.js';

/**
 * The joins of `sel` over `scope` (which holds the FROM table already): `{ rows(rt) }`, every joined row as one array
 * of the scope's width, in the brief's row order.
 */
export function planJoins(sel, scope, env) {
  void scope;
  void env;
  throw checkError(`${sel.joins[0].kind === 'left' ? 'LEFT JOIN' : 'JOIN'} is not supported yet`);
}
