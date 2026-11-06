// test.mjs — `npm test`: node --test over the suite, or over only the files it is given, with at most
// HX_TEST_CONCURRENCY test files running at once (#349). argv: --test --disable-warning=ExperimentalWarning,
// then --test-concurrency=<n> when HX_TEST_CONCURRENCY is a positive integer (else Node's default), then the
// arguments of `npm test -- <args>` unchanged and in order. An argument not starting with `-` is a file or glob:
// with none, the whole suite's glob is added (one argument; node --test expands it). So an option's value is given
// as `--opt=value`, never as a separate argument. A `--test-concurrency=<k>` argument wins over the variable.
// The variable is read here because node refuses `--test-concurrency` in NODE_OPTIONS ("is not allowed in
// NODE_OPTIONS", exit 9; checked on Node 24).
// HX_NODE_BIN swaps node (as HX_GIT_BIN swaps git); a .js/.mjs one runs under this node.
import { spawnSync } from 'node:child_process';

const SUITE = 'test/**/*.test.ts';

/** The node --test arguments for the wrapper's arguments `args` and HX_TEST_CONCURRENCY `env`. */
function testArgs(args, env) {
  const n = /^\d+$/.test(env ?? '') ? Number(env) : 0;
  const own = args.some((a) => a === '--test-concurrency' || a.startsWith('--test-concurrency='));
  return ['--test', '--disable-warning=ExperimentalWarning', ...(n > 0 && !own ? [`--test-concurrency=${n}`] : []),
    ...args, ...(args.some((a) => !a.startsWith('-')) ? [] : [SUITE])];
}

const NODE = process.env.HX_NODE_BIN;
const argv = testArgs(process.argv.slice(2), process.env.HX_TEST_CONCURRENCY);
const r = !NODE ? spawnSync(process.execPath, argv, { stdio: 'inherit' })
  : /\.m?js$/i.test(NODE) ? spawnSync(process.execPath, [NODE, ...argv], { stdio: 'inherit' })
  : spawnSync(NODE, argv, { stdio: 'inherit' });
if (r.error) console.error(`test.mjs: ${r.error.message}`);
process.exit(r.status ?? 1);
