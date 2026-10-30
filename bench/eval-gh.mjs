#!/usr/bin/env node
// Fake `gh` for the critic and security evals: the board is <HX_EVAL_GH>/board.json, nothing reaches GitHub.
// Every call is appended to calls.jsonl; `issue create` / `edit` / `comment` change only the local board,
// so the eval can read the would-be issues, labels and comments. Any other command exits 1.
// Issues and comments are by `eval` (unless an issue names its `author`): the evals set HX_TRUSTED=eval.
//
//   import { useFakeGh } from './eval-gh.mjs'   then every child process (claude, its Bash tool) gets the fake
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const original = { ...process.env };

/** Board helpers for the eval scripts. */
export const board = {
  load: (dir) => JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')),
  save: (dir, b) => writeFileSync(path.join(dir, 'board.json'), JSON.stringify(b, null, 2)),
};

/**
 * Write `gh` (for Git Bash) and `gh.cmd` (for cmd/PowerShell) into <stateDir>/bin, seed the board, and
 * return an env with that bin first on PATH, an empty GH_CONFIG_DIR and no GitHub tokens, so even a real
 * `gh` found some other way is not logged in.
 */
export function installFakeGh(stateDir, issues, base = process.env) {
  const bin = path.join(stateDir, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(stateDir, 'gh-config'), { recursive: true });
  const node = process.execPath.replace(/\\/g, '/');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${node}" "${self.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${self}" %*\r\n`);
  board.save(stateDir, { issues, next: Math.max(0, ...issues.map((i) => i.number)) + 1 });
  writeFileSync(path.join(stateDir, 'calls.jsonl'), '');
  // HX_GH_BIN: scripts/issue.mjs spawns gh without a shell, which would not find gh.cmd on Windows
  const env = { ...base, HX_EVAL_GH: stateDir, HX_GH_BIN: self, GH_CONFIG_DIR: path.join(stateDir, 'gh-config'), GH_PROMPT_DISABLED: '1' };
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[k];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = bin + path.delimiter + (env[key] ?? '');
  return env;
}

/** installFakeGh, and make its env this process's env (from the env at load: earlier calls leave nothing behind). */
export function useFakeGh(stateDir, issues) {
  const env = installFakeGh(stateDir, issues, original);
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
}

/** The text `gh issue view` prints (with `--comments`, the comments after the body). */
function viewText(i, comments) {
  const head = [`title:\t${i.title}`, `state:\t${i.state}`, `labels:\t${i.labels.join(', ')}`, `number:\t${i.number}`, '--', i.body];
  if (comments) for (const c of i.comments) head.push('--', `author:\teval`, '--', c);
  return head.join('\n') + '\n';
}

function jsonOf(i, fields) {
  const all = { ...i, author: { login: i.author ?? 'eval' }, labels: i.labels.map((name) => ({ name })), comments: i.comments.map((body) => ({ body, author: { login: 'eval' } })) };
  return Object.fromEntries(fields.split(',').map((f) => [f, all[f] ?? null]));
}

/** The few `-q` shapes worth supporting: `.field`, `.field[].name`, `.[].field`. */
function query(v, q) {
  const one = (x, p) => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), x);
  const m = /^\.\[\]\.?(.*)$/.exec(q) ?? null;
  if (m) return v.map((x) => one(x, m[1]));
  const n = /^(.*)\[\]\.(\w+)$/.exec(q);
  if (n) return (one(v, n[1]) ?? []).map((x) => x[n[2]]);
  return one(v, q);
}

function out(v, q) {
  const r = q ? query(v, q) : v;
  if (q) process.stdout.write((Array.isArray(r) ? r.join('\n') : typeof r === 'object' ? JSON.stringify(r) : String(r ?? '')) + '\n');
  else process.stdout.write(JSON.stringify(r) + '\n');
}

function main() {
  const dir = process.env.HX_EVAL_GH;
  if (!dir) { process.stderr.write('eval-gh: HX_EVAL_GH is not set\n'); process.exit(1); }
  const a = process.argv.slice(2);
  appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(a) + '\n');
  const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
  const all = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
  const b = board.load(dir);
  const find = (n) => b.issues.find((i) => i.number === Number(String(n).replace(/^#/, '')));
  const no = (msg) => { process.stderr.write(`eval-gh: ${msg}\n`); process.exit(1); };
  const bodyOf = () => {
    const f = opt('--body-file') ?? opt('-F');
    if (f === '-') return readFileSync(0, 'utf8');
    if (f) return readFileSync(f, 'utf8');
    return opt('--body') ?? opt('-b') ?? '';
  };
  const [cmd, sub, target] = a;

  if (cmd === 'issue' && sub === 'view') {
    const i = find(target) ?? no(`issue ${target} not found`);
    const fields = opt('--json');
    if (fields) out(jsonOf(i, fields), opt('-q') ?? opt('--jq'));
    else process.stdout.write(viewText(i, a.includes('--comments')));
  } else if (cmd === 'issue' && sub === 'list') {
    const state = (opt('--state') ?? opt('-s') ?? 'open').toUpperCase();
    const labels = all('--label').concat(all('-l'));
    const list = b.issues.filter((i) => (state === 'ALL' || i.state === state) && labels.every((l) => i.labels.includes(l)));
    const fields = opt('--json');
    if (fields) out(list.map((i) => jsonOf(i, fields)), opt('-q') ?? opt('--jq'));
    else process.stdout.write(list.map((i) => `${i.number}\t${i.state}\t${i.title}\t${i.labels.join(', ')}`).join('\n') + '\n');
  } else if (cmd === 'issue' && sub === 'create') {
    const n = b.next++;
    b.issues.push({ number: n, title: opt('--title') ?? opt('-t') ?? '', body: bodyOf(), state: 'OPEN', labels: all('--label').concat(all('-l')), comments: [], filed: true });
    board.save(dir, b);
    process.stdout.write(`https://github.com/eval/eval/issues/${n}\n`);
  } else if (cmd === 'issue' && sub === 'edit') {
    const i = find(target) ?? no(`issue ${target} not found`);
    for (const l of all('--add-label').flatMap((x) => x.split(','))) if (!i.labels.includes(l)) i.labels.push(l);
    const rm = all('--remove-label').flatMap((x) => x.split(','));
    i.labels = i.labels.filter((l) => !rm.includes(l));
    if (a.includes('--body') || a.includes('--body-file')) i.body = bodyOf();
    board.save(dir, b);
  } else if (cmd === 'issue' && sub === 'comment') {
    const i = find(target) ?? no(`issue ${target} not found`);
    i.comments.push(bodyOf());
    board.save(dir, b);
  } else if (cmd === 'pr' && sub === 'list') {
    process.stdout.write(opt('--json') ? '[]\n' : '');
  } else if (cmd === 'pr' && sub === 'view') {
    no('no pull requests in this eval — read the commits on the base branch');
  } else if (cmd === 'auth' && sub === 'status') {
    process.stdout.write('Logged in to github.com (eval)\n');
  } else {
    no(`'${a.slice(0, 2).join(' ')}' is not available in this eval`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) main();
