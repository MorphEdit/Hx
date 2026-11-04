// `hx install` (npx github:MorphEdit/Hx install) and `hx update`: npm install -g the latest release tag, verify the
// new hx runs from PATH, run hx doctor, offer the /hx skill. Plain JS, Node built-ins only: it runs before the
// type-stripping hook, so it works on a Node that cannot load hx's .ts files.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const REPO = 'MorphEdit/Hx';
const TAG = /^v\d+\.\d+\.\d+$/;

// The newest vX.Y.Z release tag from the GitHub API (HX_GITHUB_API overrides the host), or null when the lookup fails.
export async function latestTag(env = process.env) {
  const api = (env.HX_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${api}/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hx-installer' }, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const tag = (await res.json())?.tag_name;
    return typeof tag === 'string' && TAG.test(tag) ? tag : null;
  } catch { return null; }
}

// The first `name` on PATH: on Windows the .exe / .cmd / .bat (npm's hx.cmd shim), never the extensionless sh script.
export function which(name, env = process.env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  for (const dir of (env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// The .js/.mjs script an npm cmd shim (hx.cmd) runs: `"%dp0%\node_modules\hx\bin\hx.mjs" %*`. null if it is not one.
export function shimTarget(cmdFile) {
  let text;
  try { text = readFileSync(cmdFile, 'utf8'); } catch { return null; }
  const m = /"%~?dp0%?\\?([^"%]+\.m?js)"/i.exec(text);
  return m ? path.join(path.dirname(cmdFile), m[1]) : null;
}

// [command, args] that runs `bin` without a shell: a .js/.mjs (a test fake, a shim's target) under this node,
// a .cmd/.bat through cmd.exe (Node refuses to spawn one directly); the args are fixed words and a checked tag.
function command(bin, args) {
  if (/\.m?js$/i.test(bin)) return [process.execPath, [bin, ...args]];
  if (/\.(cmd|bat)$/i.test(bin)) {
    const target = shimTarget(bin);
    if (target) return [process.execPath, [target, ...args]];
    return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[`"${bin}"`, ...args].join(' ')}"`]];
  }
  return [bin, args];
}

function exec(bin, args, env, capture = true) {
  const [cmd, argv] = command(bin, args);
  const r = spawnSync(cmd, argv, { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: cmd !== process.execPath && /cmd(\.exe)?$/i.test(cmd),
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
  return { code: r.error ? 1 : (r.status ?? 1), out: r.error ? String(r.error.message) : `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// npm: HX_NPM_BIN, else on Windows the npm-cli.js that ships next to node (no .cmd), else npm on PATH.
function npmBin(env) {
  if (env.HX_NPM_BIN) return env.HX_NPM_BIN;
  if (process.platform !== 'win32') return 'npm';
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? cli : which('npm', env) ?? 'npm.cmd';
}

// npm with `args` in `cwd`, without blocking (a watching runner's self-update): { code, out }.
export function npmInstall(args, env = process.env, cwd = undefined) {
  const [cmd, argv] = command(npmBin(env), args);
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(cmd, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: cmd !== process.execPath && /cmd(\.exe)?$/i.test(cmd) });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ code: 1, out: String(e.message) }));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

// The checkout an `npm link` install of `hxPath` points at, or null: hx's package folder (two up from its
// bin/hx.mjs, symlinks resolved) holds a .git.
export function linkedCheckout(hxPath) {
  if (!hxPath) return null;
  const script = /\.(cmd|bat)$/i.test(hxPath) ? shimTarget(hxPath) : hxPath;
  if (!script) return null;
  try {
    const pkg = path.dirname(path.dirname(realpathSync(script)));
    return existsSync(path.join(pkg, '.git')) ? pkg : null;
  } catch { return null; }
}

// `Install the /hx skill for Claude Code? [y/N]`: No without a TTY or without an answer.
async function askSkill(stdin) {
  process.stdout.write('Install the /hx skill for Claude Code? [y/N] ');
  if (!stdin.isTTY) { console.log('N (no terminal)'); return false; }
  const rl = createInterface({ input: stdin, output: process.stdout });
  const answer = await new Promise((resolve) => { rl.question('', resolve); rl.once('close', () => resolve('')); });
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

/** `hx install [--version vX.Y.Z] [--force]` (`update`: the latest release, --force only). Returns the exit code. */
export async function install(args, { env = process.env, stdin = process.stdin, update = false } = {}) {
  let ref = null, force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') force = true;
    else if (a === '--version' && !update) {
      const v = args[++i];
      if (!v || !/^v?\d+\.\d+\.\d+$/.test(v)) { console.error('hx install: --version needs a release tag like v0.1.0'); return 2; }
      ref = v.startsWith('v') ? v : `v${v}`;
    } else { console.error(`hx ${update ? 'update' : 'install'}: unknown argument ${a}`); return 2; }
  }

  if (!ref) {
    ref = await latestTag(env);
    if (ref) console.log(`latest release: ${ref}`);
    else console.log(`could not look up the latest release tag; installing from the default branch of ${REPO}`);
  }

  const before = which('hx', env);
  const checkout = linkedCheckout(before);
  if (checkout && !force) {
    console.log(`hx is an npm link of the checkout ${checkout}: not overwriting it. Update it with git pull there, or run again with --force.`);
    return 1;
  }
  const prev = before ? exec(before, ['--version'], env) : null;
  const a = prev && prev.code === 0 ? prev.out.trim().split(/\r?\n/).pop()?.replace(/^v/, '') : null;

  const spec = `github:${REPO}${ref ? `#${ref}` : ''}`;
  console.log(`npm install -g ${spec}`);
  const npm = exec(npmBin(env), ['install', '-g', spec], env, false);
  if (npm.code !== 0) {
    console.error(`hx: npm install -g ${spec} failed (exit ${npm.code}).`);
    console.error('If npm could not write to its global folder, do not use sudo or an admin shell: use a Node version manager');
    console.error('(nvm, fnm, nvm-windows), or point npm at a folder you own: npm config set prefix ~/.npm-global (and put its bin on PATH).');
    return 1;
  }

  const after = which('hx', env);
  const ver = after ? exec(after, ['--version'], env) : { code: 1, out: 'hx: not found on PATH' };
  if (ver.code !== 0) {
    console.error('hx was installed but does not run from a new terminal.');
    if (ver.out.trim()) console.error(ver.out.trim());
    console.error("npm's global bin folder must be on PATH: run `npm prefix -g` to see it (on Windows hx.cmd is in that folder, elsewhere in its bin/).");
    return 1;
  }
  const b = ver.out.trim().split(/\r?\n/).pop()?.replace(/^v/, '');
  console.log(a ? `hx v${a} → v${b}` : `hx v${b} (fresh install)`);

  const doctor = exec(after, ['doctor'], env);
  if (doctor.out.trim()) console.log(doctor.out.trimEnd());

  if (await askSkill(stdin)) exec(after, ['install-skill'], env, false);
  return 0;
}
