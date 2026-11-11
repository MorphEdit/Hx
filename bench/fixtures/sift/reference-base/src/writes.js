// The statements that change tables (INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE) and writing the changed tables
// when a run has succeeded. Not built yet: a sibling issue of PRD #446 builds them here.
import { checkError } from './errors.js';

/** Run a statement that changes tables, in `env.session`: `{ message }`. */
export function executeWrite(stmt, env) {
  void env;
  const name = stmt.type === 'create' || stmt.type === 'drop' ? `${stmt.type} table` : stmt.type;
  throw checkError(`${name.toUpperCase()} is not supported yet`);
}

/** Write every table the session changed, each atomically. Nothing to write until the statements above exist. */
export function commit(session) {
  void session;
}
