// ghwait.mjs — the gh caller ship.mjs and issue.mjs share: a call that fails on a GitHub rate limit is waited out
// and retried, but only briefly. Workers run these scripts through Claude Code's Bash tool, which kills a command
// after a few minutes, so the total wait per script run is capped at HX_GH_WAIT_MAX_SECONDS (default 90); a wait
// that would end past the cap is not started, and the failing result is returned as if there were no wait at all.
//   secondary: Retry-After from stderr, else 60 s, doubled on each repeat · primary: until the reset of the bucket
//   `gh api rate_limit` shows at 0 (else the later reset; a failed read 60 s) — the same rules as hx (src/ghlimit.ts)
// HX_GH_BIN swaps gh (as in hx itself); a .js/.mjs one runs under this node.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyLimit, hhmm, limitWaitMs, parseRateLimit } from '../src/ghlimit.ts';

// HX_GH_INPROC (set by the tests): the fake gh it names runs in-process, the same answers without a node start per call
const INPROC = process.env.HX_GH_INPROC;
const fake = INPROC ? await import(pathToFileURL(path.resolve(INPROC)).href) : null;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A sync `gh(args, opts)` → spawnSync result; `name` prefixes its stderr lines. */
export function ghCaller(name) {
  const GH = process.env.HX_GH_BIN || 'gh';
  // null: run it as a program (another gh, a call with its own env, or one the fake keeps out of process)
  const inProcess = (a, opts) => {
    if (!fake || opts.env || path.resolve(GH) !== path.resolve(INPROC)) return null;
    const r = fake.gh(a, { input: () => opts.input ?? '', cwd: opts.cwd ?? process.cwd(), inProcess: true });
    return r && { status: r.code, stdout: r.stdout, stderr: r.stderr };
  };
  const raw = (a, opts = {}) => inProcess(a, opts) ?? (/\.m?js$/i.test(GH)
    ? spawnSync(process.execPath, [GH, ...a], { encoding: 'utf8', ...opts })
    : spawnSync(GH, a, { encoding: 'utf8', ...opts }));
  const env = Number(process.env.HX_GH_WAIT_MAX_SECONDS);
  const capMs = (process.env.HX_GH_WAIT_MAX_SECONDS !== undefined && env >= 0 ? env : 90) * 1000;
  let waited = 0; // ms, over the whole script run
  return (a, opts = {}) => {
    let streak = 0; // secondary limits in a row
    for (;;) {
      const r = raw(a, opts);
      if (r.status === 0 || r.error) return r;
      const k = classifyLimit(r.stderr || r.stdout);
      if (!k) return r;
      streak = k.kind === 'secondary' ? streak + 1 : 0;
      const budget = k.kind === 'primary' ? parseRateLimit(raw(['api', 'rate_limit']).stdout ?? '') : null;
      const now = Date.now(), ms = limitWaitMs(k, budget, streak, now);
      if (waited + ms > capMs) {
        console.error(`${name}: github ${k.kind} rate limit — rate limited until ${hhmm(Math.ceil((now + ms) / 1000))}`);
        return r;
      }
      console.error(`${name}: github ${k.kind} rate limit — waiting ${Math.ceil(ms / 1000)}s, then retrying`);
      sleep(ms);
      waited += ms;
    }
  };
}
