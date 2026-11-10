// The command line, read and checked before anything else is: every error here is a usage error (exit 1).
//
// Options come after the command, in any order and mixed with its arguments; each takes the next argument as its value,
// whatever it looks like. Anything else that starts with `-` is an unknown option. An option given twice is an error,
// except `--account` for the commands that take filters. `add` takes no options: every argument is read in place.
import { isAmount, parseAmount } from './amount.js';
import { UsageError } from './errors.js';
import { isAccount, isCurrency, isDate, isMonth, trimWhitespace } from './names.js';

const FILTERS = ['--account', '--from', '--to', '--payee', '--currency'];

/** Per command: the options it takes, and how many arguments (min, max). */
export const COMMANDS = {
  check: { options: [], args: [0, 0] },
  accounts: { options: [], args: [0, 0] },
  account: { options: [], args: [1, 1] },
  add: { options: null, args: [0, Infinity] },
  balance: { options: [...FILTERS, '--depth', '--sort'], args: [0, 0] },
  register: { options: [...FILTERS, '--sort'], args: [0, 0] },
  report: { options: [...FILTERS], args: [1, 1] },
  print: { options: [...FILTERS], args: [0, 0] },
  export: { options: [...FILTERS], args: [0, 0] },
  budget: { options: ['--budget'], args: [0, 1] },
  import: { options: ['--account', '--rules', '--default'], args: [1, 1] },
};

const SORTS = { balance: ['name', 'amount'], register: ['date', 'amount'] };
const PERIODS = ['month', 'quarter', 'year'];

const usage = (message) => {
  throw new UsageError(message);
};

/** The options and arguments of a command other than `add`: { options: { name: [values] }, args }. */
function split(command, argv) {
  const spec = COMMANDS[command];
  const options = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) {
      args.push(a);
      continue;
    }
    if (!spec.options.includes(a)) {
      usage(`${command} does not take the option ${a}`);
    }
    if (i + 1 >= argv.length) {
      usage(`${a} needs a value`);
    }
    const repeatable = a === '--account' && command !== 'import';
    if (options[a] && !repeatable) {
      usage(`${a} is given twice`);
    }
    (options[a] ??= []).push(argv[i + 1]);
    i += 1;
  }
  const [min, max] = spec.args;
  if (args.length < min) {
    usage(`${command} needs ${min === 1 ? 'an argument' : `${min} arguments`}`);
  }
  if (args.length > max) {
    usage(`${command} takes ${max === 0 ? 'no arguments' : `at most ${max}`}: ${args[max]}`);
  }
  return { options, args };
}

/** The filters of the options, each checked. */
function filters(options) {
  const out = {};
  const one = (name) => options[name]?.[0];
  if (options['--account']) {
    for (const name of options['--account']) {
      if (!isAccount(name)) {
        usage(`--account: not an account name: ${name}`);
      }
    }
    out.account = [...options['--account']];
  }
  for (const [flag, key] of [['--from', 'from'], ['--to', 'to']]) {
    const v = one(flag);
    if (v === undefined) {
      continue;
    }
    if (!isDate(v)) {
      usage(`${flag}: not a real date: ${v}`);
    }
    out[key] = v;
  }
  if (out.from !== undefined && out.to !== undefined && out.from > out.to) {
    usage('--from is after --to');
  }
  if (one('--payee') !== undefined) {
    out.payee = one('--payee');
  }
  const currency = one('--currency');
  if (currency !== undefined) {
    if (!isCurrency(currency)) {
      usage(`--currency: not a currency: ${currency}`);
    }
    out.currency = currency;
  }
  return out;
}

/** `add`'s arguments: a date (or `today`), a payee, then postings, each an account and maybe an amount and currency. */
function readAdd(argv) {
  if (argv.length < 2) {
    usage('add needs a date, a payee and at least two postings');
  }
  const [date, rawPayee, ...rest] = argv;
  if (date !== 'today' && !isDate(date)) {
    usage(`add: not a real date: ${date}`);
  }
  const payee = trimWhitespace(rawPayee);
  if (payee === '') {
    usage('add: the payee is empty');
  }
  if (/[\r\n]/.test(payee)) {
    usage('add: the payee holds a line break');
  }
  const postings = [];
  let i = 0;
  while (i < rest.length) {
    const account = rest[i];
    if (!isAccount(account)) {
      usage(`add: not an account name: ${account}`);
    }
    i += 1;
    if (i < rest.length && isAmount(rest[i])) {
      const amount = parseAmount(rest[i]);
      const currency = rest[i + 1];
      if (!isCurrency(currency)) {
        usage(`add: an amount needs a currency after it: ${rest[i]}`);
      }
      postings.push({ account, amount, currency });
      i += 2;
    } else {
      postings.push({ account, amount: null, currency: null });
    }
  }
  if (postings.length < 2) {
    usage('add needs at least two postings');
  }
  return { command: 'add', date, payee, postings };
}

/**
 * The command line read and checked: { command, ... } with what the command needs. Throws a UsageError for anything
 * wrong in it.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    usage('no command: check, accounts, account, add, balance, register, report, print, export, budget or import');
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    usage(`unknown command: ${command}`);
  }
  if (command === 'add') {
    return readAdd(rest);
  }
  const { options, args } = split(command, rest);
  const out = { command };
  switch (command) {
    case 'account':
      if (!isAccount(args[0])) {
        usage(`not an account name: ${args[0]}`);
      }
      out.name = args[0];
      break;
    case 'balance':
    case 'register':
      Object.assign(out, filters(options));
      if (options['--sort']) {
        const sort = options['--sort'][0];
        if (!SORTS[command].includes(sort)) {
          usage(`--sort is ${SORTS[command].join(' or ')}: ${sort}`);
        }
        out.sort = sort;
      }
      if (options['--depth']) {
        const depth = options['--depth'][0];
        if (!/^\d+$/.test(depth) || Number(depth) < 1) {
          usage(`--depth is a whole number, at least 1: ${depth}`);
        }
        out.depth = Number(depth);
      }
      break;
    case 'report':
      if (!PERIODS.includes(args[0])) {
        usage(`report month, quarter or year: ${args[0]}`);
      }
      out.period = args[0];
      Object.assign(out, filters(options));
      break;
    case 'print':
    case 'export':
      Object.assign(out, filters(options));
      break;
    case 'budget':
      if (args[0] !== undefined && !isMonth(args[0])) {
        usage(`not a month (YYYY-MM): ${args[0]}`);
      }
      out.month = args[0] ?? null;
      out.budgetFile = options['--budget']?.[0] ?? null;
      break;
    case 'import': {
      out.csvFile = args[0];
      const account = options['--account']?.[0];
      if (account === undefined) {
        usage('import needs --account');
      }
      if (!isAccount(account)) {
        usage(`--account: not an account name: ${account}`);
      }
      out.account = account;
      out.rulesFile = options['--rules']?.[0] ?? null;
      const fallback = options['--default']?.[0];
      if (fallback !== undefined && !isAccount(fallback)) {
        usage(`--default: not an account name: ${fallback}`);
      }
      out.fallback = fallback ?? null;
      break;
    }
    default:
      break;
  }
  return out;
}
