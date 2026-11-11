// The command line: arguments (usage, exit 1), the environment (SIFT_TODAY, SIFT_DB, the script file: exit 2), then
// the statements. Results go to stdout; an error is one `error: ` line on stderr with its exit code, and stdout empty.
import { readFileSync } from 'node:fs';
import { EXIT, SiftError, envError, usageError } from './errors.js';
import { Session, dataDir, listTables } from './db.js';
import { FORMATS, format } from './format.js';
import { isIdentifier } from './lexer.js';
import { parseScript, parseStatement } from './parser.js';
import { runStatements, todayFrom } from './sift.js';

/** Each command: how many arguments it takes and which options. */
const COMMANDS = {
  query: { args: 1, options: ['format'] },
  run: { args: 1, options: ['format'] },
  tables: { args: 0, options: [] },
  schema: { args: 1, options: [] },
};

/** An argument made only of `--` and one or more of `a`-`z` and `-` is an option. */
const OPTION = /^--[a-z-]+$/;

/** The command line read: `{ command, args, format }`, or exit 1. */
export function parseArgs(argv) {
  if (argv.length === 0) throw usageError('no command (query, run, tables or schema)');
  const command = argv[0];
  if (!Object.hasOwn(COMMANDS, command)) throw usageError(`unknown command: ${JSON.stringify(command)}`);
  const spec = COMMANDS[command];
  const args = [];
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!OPTION.test(a)) { args.push(a); continue; }
    const name = a.slice(2);
    if (!spec.options.includes(name)) throw usageError(`${command} does not take ${a}`);
    if (Object.hasOwn(options, name)) throw usageError(`${a} given twice`);
    if (i + 1 >= argv.length) throw usageError(`${a} needs a value`);
    const value = argv[++i];
    if (name === 'format' && !FORMATS.includes(value)) throw usageError(`--format takes ${FORMATS.join(', ')}, not ${JSON.stringify(value)}`);
    options[name] = value;
  }
  if (args.length < spec.args) throw usageError(`${command} needs ${spec.args === 1 ? 'an argument' : 'arguments'}`);
  if (args.length > spec.args) throw usageError(`too many arguments to ${command}`);
  if (command === 'schema' && !isIdentifier(args[0])) throw usageError(`not a table name: ${JSON.stringify(args[0])}`);
  return { command, args, format: options.format ?? 'table' };
}

function runCommand(argv, env) {
  const { command, args, format: fmt } = parseArgs(argv);
  const today = todayFrom(env.SIFT_TODAY);
  if (env.SIFT_DB === undefined || env.SIFT_DB === '') throw envError('SIFT_DB is not set');
  const dir = dataDir(env.SIFT_DB);
  switch (command) {
    case 'tables': return listTables(dir).map((n) => `${n}\n`).join('');
    case 'schema': {
      const name = args[0].toLowerCase();
      const table = new Session(dir).table(name);
      return table.columns.map((c) => `${c.name} ${c.type}\n`).join('');
    }
    case 'query': return format(runStatements([parseStatement(args[0])], { dir, today })[0], fmt);
    default: {
      let text;
      try { text = readFileSync(args[0], 'utf8'); } catch { throw envError(`cannot read the script ${JSON.stringify(args[0])}`); }
      return runStatements(parseScript(text), { dir, today }).map((r) => format(r, fmt)).join('');
    }
  }
}

/** The command line run: `{ code, stdout, stderr }`. */
export function main(argv, env) {
  try {
    return { code: 0, stdout: runCommand(argv, env), stderr: '' };
  } catch (e) {
    if (e instanceof SiftError) return { code: e.exitCode, stdout: '', stderr: `error: ${e.message}\n` };
    const msg = e instanceof RangeError ? 'out of memory or stack' : `internal error: ${e?.message ?? e}`;
    return { code: EXIT.runtime, stdout: '', stderr: `error: ${msg.replace(/[\r\n]+/g, ' ')}\n` };
  }
}
