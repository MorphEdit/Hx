// Fake `gh` for tests: the board lives in the JSON file named by HX_FAKE_STATE.
// A program (node gh.mjs …), or in-process: gh(args, { input, cwd, inProcess: true }) → { code, stdout, stderr }, the
// same answers and recorded calls without a node start per call. hx (src/exec.ts) and the scripts (ghwait.mjs) call it
// that way when HX_GH_INPROC names this file, as test/isolate.ts sets it; null = run it as a program.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadJson, locked, saveJson } from './lock.mjs';

class Exit { constructor(code) { this.code = code; } }

export function gh(a, { input = () => '', cwd = process.cwd(), inProcess = false } = {}) {
  let stdout = '', stderr = '';
  const print = (x) => { stdout += x; }, printErr = (x) => { stderr += x; };
  const exit = (code) => { throw new Exit(code); };
  try {
    return main() === null ? null : { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e instanceof Exit ? e.code : 1, stdout, stderr: e instanceof Exit ? stderr : stderr + (e?.stack ?? String(e)) };
  }

  function main() {
    const file = process.env.HX_FAKE_STATE;
    const load = () => loadJson(file);
    const save = (s) => saveJson(file, s);
    const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
    const all = (n) => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
    const find = (s, n) => s.issues.find((i) => i.number === Number(n));
    const withStdin = (fn) => fn(input());
    const mutate = (fn) => locked(file, () => { const cur = load(); const r = fn(cur); save(cur); return r; });
    const ghLabels = (i) => i.labels.map((name) => ({ name }));

    const s = load();
    // state.waitFor = { match, file, mark? }: every call whose arguments contain `match` waits until `file` exists (an
    // event in another process, not a time: the call goes on as soon as it happens); one that waits first writes `mark`
    const waitFor = s.waitFor && a.join(' ').includes(s.waitFor.match) && !existsSync(s.waitFor.file) ? s.waitFor : null;
    // a slow read blocks: in-process it would stop the caller's event loop, so the caller runs it as a program
    if (inProcess && (s.slowList || s.slowClosedState || waitFor || (s.slowNext && a.join(' ').includes(s.slowNext.match)))) return null;
    if (waitFor?.mark) writeFileSync(waitFor.mark, '');
    if (waitFor) while (!existsSync(waitFor.file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    // state.slowNext = { match, ms }: the next call whose arguments contain `match` takes ms (once)
    const slowNext = s.slowNext && a.join(' ').includes(s.slowNext.match)
      && mutate((cur) => { const x = cur.slowNext; if (!x || !a.join(' ').includes(x.match)) return null; delete cur.slowNext; return x; });
    if (slowNext) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowNext.ms);
    // HX_FAKE_GH_LOG: every call appends its arguments as one line (tests count calls)
    if (process.env.HX_FAKE_GH_LOG) appendFileSync(process.env.HX_FAKE_GH_LOG, a.join(' ') + '\n');
    // HX_FAKE_GH_TIMES: the same, each line prefixed with Date.now() (tests time the calls, not the whole run)
    if (process.env.HX_FAKE_GH_TIMES) appendFileSync(process.env.HX_FAKE_GH_TIMES, `${Date.now()} ${a.join(' ')}\n`);
    // the account gh is logged in as: state.login (default 'me'); state.loginFails makes `gh api user` fail.
    // An issue or comment without an `author` was opened by it; author '' = a deleted account (gh gives no login).
    // state.limitNext = { match, kind: 'primary' | 'secondary', times, retryAfter? }: the next `times` calls whose
    // arguments contain `match` fail with a rate-limit error (Retry-After only when retryAfter is set)
    const limit = s.limitNext && a.join(' ').includes(s.limitNext.match) ? mutate((cur) => {
      const l = cur.limitNext;
      if (!l || !(l.times > 0) || !a.join(' ').includes(l.match)) return null;
      if (--l.times <= 0) delete cur.limitNext;
      return { ...l };
    }) : null;
    if (limit) {
      const l = limit;
      printErr(l.kind === 'secondary'
        ? `HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.${l.retryAfter !== undefined ? ` Retry-After: ${l.retryAfter}` : ''}`
        : 'HTTP 403: API rate limit exceeded for user ID 1.');
      exit(1);
    }
    const LOGIN = s.login ?? 'me';
    // state.authStatus: 'out' = gh auth status answers logged out, 'offline' = it fails on the network (logged in by default)
    // state.repoViewFails: 'notfound' = no GitHub remote, 'offline' = a network failure; state.labelListFails: label list fails
    if (a[0] === 'auth' && a[1] === 'status') {
      if (s.authStatus === 'out') { printErr('You are not logged into any GitHub hosts. To log in, run: gh auth login\n'); exit(1); }
      if (s.authStatus === 'offline') { printErr('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n'); exit(1); }
      print(`github.com\n  ✓ Logged in to github.com account ${LOGIN} (keyring)\n`);
      exit(0);
    }
    if (a[0] === 'repo' && a[1] === 'view' && s.repoViewFails) {
      printErr(s.repoViewFails === 'notfound' ? 'none of the git remotes configured for this repository point to a known GitHub host\n'
        : 'error connecting to api.github.com\n');
      exit(1);
    }
    if (a[0] === 'label' && a[1] === 'list' && s.labelListFails) { printErr('error connecting to api.github.com\n'); exit(1); }
    const author = (x) => ({ login: x.author ?? LOGIN });
    if (a[0] === 'issue' && a[1] === 'list') {
      // state.listFails: true, or the one repo (-R) whose list fails; an issue with a `repo` is listed only for that repo
      if (s.listFails === true || (s.listFails && s.listFails === opt('-R'))) { printErr('HTTP 502: Bad Gateway'); exit(1); }
      const state = opt('--state') ?? 'open';
      const label = opt('--label'); // --label L: only issues carrying L (an issue may store closedAt and stateReason)
      // an issue with hiddenReads k (state.createHiddenReads at its creation) is left out of the next k lists: GitHub lagging
      if (s.issues.some((i) => i.hiddenReads > 0)) mutate((cur) => { for (const i of cur.issues) if (i.hiddenReads > 0) i.hiddenReads--; });
      const out = s.issues.filter((i) => !(i.hiddenReads > 0) && (state === 'all' || i.state === state.toUpperCase()) && (!i.repo || i.repo === opt('-R'))
        && (!label || i.labels.includes(label))).map((i) => ({ ...i, labels: ghLabels(i), author: author(i) }));
      // state.slowList = { add, wake, ms }: a slow read — once the list is taken, `add` joins the board and `wake` is
      // written, then the answer (without it) comes ms later (a wake that lands while hx reads the board)
      const slow = s.slowList && mutate((cur) => { const x = cur.slowList; delete cur.slowList; if (x) cur.issues.push(x.add); return x; });
      if (slow) { writeFileSync(slow.wake, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow.ms); }
      print(JSON.stringify(out));
    } else if (a[0] === 'pr' && a[1] === 'list') {
      // like gh, --head matches the branch name only: a PR from a fork (`fork: true`) with that name matches too
      // state.prListLag = k: a new PR is missing from the next k lists (GitHub's delay, see #65)
      const hidden = mutate((cur) => (cur.prs ?? []).filter((p) => p.head === opt('--head') && p.state === 'OPEN' && p.hide > 0)
        .map((p) => { p.hide--; return p.number; }));
      // without --head: every PR in --state (open | merged | all), e.g. the health pass's stale-PR check
      const want = (opt('--state') ?? 'open').toUpperCase();
      const prs = (s.prs ?? []).filter((p) => (opt('--head') === undefined || p.head === opt('--head')) && (want === 'ALL' || p.state === want) && !hidden.includes(p.number));
      if (opt('-q')) print(prs[0] ? `${prs[0].number}\n` : '\n');
      else print(JSON.stringify(prs.map((p) => ({ number: p.number, title: p.title, headRefName: p.head,
        mergeable: p.mergeable ?? 'MERGEABLE', isCrossRepository: !!p.fork }))));
    } else if (a[0] === 'pr' && a[1] === 'diff') {
      // --name-only: a PR's `files` (paths, one per line); state.prDiffFails makes it fail
      if (s.prDiffFails) { printErr('HTTP 502: Bad Gateway'); exit(1); }
      const pr = (s.prs ?? []).find((p) => p.number === Number(a[2]));
      if (!pr) { printErr(`no pull requests found for "${a[2]}"`); exit(1); }
      if (!a.includes('--name-only')) { printErr('fake gh: pr diff supports --name-only only'); exit(1); }
      print((pr.files ?? []).map((f) => f + '\n').join(''));
    } else if (a[0] === 'pr' && a[1] === 'close') {
      // a PR's comment is stored as { pr, body }; --delete-branch is recorded on the PR (tests check it is never passed)
      mutate((cur) => {
        const pr = (cur.prs ?? []).find((p) => p.number === Number(a[2]));
        if (!pr) return;
        pr.state = 'CLOSED';
        if (a.includes('--delete-branch')) pr.deletedBranch = true;
        if (opt('--comment')) cur.comments.push({ pr: pr.number, body: opt('--comment'), author: LOGIN });
      });
    } else if (a[0] === 'pr' && a[1] === 'create') {
      const number = mutate((cur) => {
        cur.prs ??= [];
        const n = 100 + cur.prs.length;
        cur.prs.push({ number: n, head: opt('--head'), base: opt('--base'), title: opt('--title'), body: opt('--body'), state: 'OPEN', hide: cur.prListLag ?? 0 });
        return n;
      });
      print(`https://github.com/me/app/pull/${number}\n`);
    } else if (a[0] === 'pr' && a[1] === 'view') {
      const pr = [...(s.prs ?? [])].reverse().find((p) => p.head === a[2] && !p.fork);
      if (!pr) { printErr(`no pull requests found for branch "${a[2]}"`); exit(1); }
      print(JSON.stringify({ number: pr.number, state: pr.state }));
    } else if (a[0] === 'pr' && a[1] === 'merge') {
      // HX_FAKE_AUTOMERGE: the repo only accepts auto-merge, which lands (and closes the issue) at once
      if (process.env.HX_FAKE_AUTOMERGE && !a.includes('--auto')) { printErr('Pull request is not mergeable'); exit(1); }
      // state.mergeFails: every merge fails as GitHub's does when it cannot build the merge commit (auto-merge too, as in a
      // repo that does not allow it); state.mergeNeedsBase = <bare origin>: it fails so while that origin's main is not an
      // ancestor of --match-head-commit (a PR landed on the base after the head was tested)
      const behind = () => spawnSync('git', ['-C', s.mergeNeedsBase, 'merge-base', '--is-ancestor', 'main', opt('--match-head-commit') ?? 'HEAD']).status !== 0;
      if (s.mergeFails || (s.mergeNeedsBase && behind())) {
        mutate((cur) => { cur.mergeRefused = (cur.mergeRefused ?? 0) + 1; });
        printErr(`GraphQL: Pull request #${a[2]} is not mergeable: the merge commit cannot be cleanly created. (mergePullRequest)`);
        exit(1);
      }
      mutate((cur) => {
        const pr = (cur.prs ?? []).find((p) => p.number === Number(a[2]));
        pr.state = 'MERGED';
        pr.mergedHead = opt('--match-head-commit');
        if (process.env.HX_FAKE_AUTOMERGE) { const n = Number(/issue\/(\d+)/.exec(pr.head)?.[1]); const i = find(cur, n); if (i) i.state = 'CLOSED'; }
      });
    } else if (a[0] === 'issue' && a[1] === 'view' && opt('-q') === '.state') {
      print(find(s, a[2]).state + '\n');
    } else if (a[0] === 'issue' && a[1] === 'view') {
      const i = find(s, a[2]);
      if (!i) { printErr(`GraphQL: Could not resolve to an issue or pull request with the number of ${a[2]}.`); exit(1); }
      const fields = opt('--json').split(',');
      // state.viewFails = [n, …]: reading issue n with its title and comments (the formatter's read) fails
      if (s.viewFails?.includes(i.number) && fields.includes('title') && fields.includes('comments')) { printErr('HTTP 502: Bad Gateway'); exit(1); }
      const out = {};
      // authors are stored as a login string, or left out (a deleted account: gh gives no login)
      const ghAuthor = (login) => (login ? { login } : null);
      for (const k of ['number', 'title', 'state', 'createdAt']) if (fields.includes(k)) out[k] = i[k];
      if (fields.includes('author')) out.author = ghAuthor(i.author);
      if (fields.includes('labels')) out.labels = ghLabels(i);
      if (fields.includes('body')) out.body = i.body;
      if (fields.includes('comments')) {
        out.comments = s.comments.filter((c) => c.issue === i.number)
          .map((c) => ({ author: ghAuthor(c.author ?? LOGIN), body: c.body, createdAt: c.createdAt ?? '' }));
      }
      print(JSON.stringify(out));
    } else if (a[0] === 'api' && a[1] === 'user') {
      if (s.loginFails) { printErr('HTTP 401: Bad credentials'); exit(1); }
      print(opt('-q') === '.login' ? `${LOGIN}
    ` : JSON.stringify({ login: LOGIN }));
    } else if (a[0] === 'api' && a[1] === 'rate_limit') {
      // state.rateLimit = { core: {limit, remaining, reset}, graphql: {...} } (default: both 5000/5000, reset an hour from now);
      // state.rateLimitFails: true makes it fail.
      // state.rateLimit may also be a list of phases { for (s), core: {limit, remaining, resetIn?}, graphql }, timed from the
      // first read (whole seconds, kept in state.rateLimitStart): a bucket resets as its phase ends, or resetIn s after the
      // start; a phase without `for` lasts forever (a budget that resets, whatever a runner's start costs)
      if (s.rateLimitFails) { printErr('HTTP 502: Bad Gateway'); exit(1); }
      const full = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 };
      let rl = s.rateLimit ?? {};
      if (Array.isArray(rl)) {
        const start = s.rateLimitStart ?? mutate((cur) => (cur.rateLimitStart ??= Math.ceil(Date.now() / 1000)));
        let end = start, phase = rl.at(-1);
        for (const p of rl) { if (p.for === undefined) { phase = p; end = undefined; break; } end += p.for; if (Date.now() / 1000 < end) { phase = p; break; } }
        const b = (x) => x && { limit: x.limit, remaining: x.remaining, reset: x.resetIn !== undefined ? start + x.resetIn : end ?? full.reset };
        rl = { core: b(phase.core), graphql: b(phase.graphql) };
      }
      print(JSON.stringify({ resources: { core: rl.core ?? full, graphql: rl.graphql ?? full } }));
    } else if (a[0] === 'api' && a[1] === 'graphql') {
      // the paged issues query of hx usage --compare: state.graphqlPage issues per page (default 50), the cursor is the
      // next index; an issue may store createdAt, closedAt and stateReason, a comment createdAt
      const field = (k) => all('-f').find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1);
      const size = s.graphqlPage ?? 50, at = Number(field('after') ?? 0);
      const ghAuthor = (login) => (login ? { login } : null);
      const nodes = s.issues.slice(at, at + size).map((i) => ({ number: i.number, state: i.state, stateReason: i.stateReason ?? null,
        createdAt: i.createdAt ?? '', closedAt: i.closedAt ?? null, body: i.body ?? '', author: ghAuthor(i.author ?? LOGIN), labels: { nodes: ghLabels(i) },
        comments: { nodes: s.comments.filter((c) => c.issue === i.number).map((c) => ({ author: ghAuthor(c.author ?? LOGIN), body: c.body, createdAt: c.createdAt ?? '' })) } }));
      const more = at + size < s.issues.length;
      print(JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: more, endCursor: more ? String(at + size) : null }, nodes } } } }));
    } else if (a[0] === 'api') {
      const path = a.find((x) => x.startsWith('repos/'));
      const one = /issues\/(\d+)$/.exec(path);
      if (one) {
        const i = find(s, one[1]);
        if (!i) { printErr('HTTP 404: Not Found'); exit(1); }
        // state.slowClosedState = ms: reading a closed issue's state takes ms (hx checking a finished session on a loaded machine)
        if (s.slowClosedState && i.state === 'CLOSED') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.slowClosedState);
        print(i.state.toLowerCase() + '\n');
      } else {
        print(s.issues.map((i) => `${i.number}\t${i.state.toLowerCase()}\n`).join(''));
      }
    } else if (a[0] === 'issue' && a[1] === 'edit') {
      // state.labelFails = k: the next k edits that remove a label fail (-1: every one)
      if (all('--remove-label').length && mutate((cur) => { if (!cur.labelFails) return false; if (cur.labelFails > 0) cur.labelFails--; return true; })) {
        printErr('HTTP 502: Bad Gateway'); exit(1);
      }
      // state.strictLabels: adding a label missing from state.labels fails like GitHub does
      const unknown = s.strictLabels ? all('--add-label').find((l) => !(s.labels ?? []).includes(l)) : undefined;
      if (unknown) { printErr(`failed to update https://github.com/me/app/issues/${a[2]}: '${unknown}' not found\n`); exit(1); }
      const edit = (body) => mutate((cur) => {
        const i = find(cur, a[2]);
        i.labels = [...new Set([...i.labels, ...all('--add-label')])].filter((l) => !all('--remove-label').includes(l));
        if (body !== undefined) i.body = body;
      });
      const bf = opt('--body-file');
      if (bf === '-') withStdin(edit);
      else edit(bf === undefined ? undefined : readFileSync(path.resolve(cwd, bf), 'utf8'));
    } else if (a[0] === 'label' && a[1] === 'list') {
      print((s.labels ?? []).map((l) => l + '\n').join(''));
    } else if (a[0] === 'label' && a[1] === 'create') {
      mutate((cur) => { cur.labels = [...new Set([...(cur.labels ?? []), a[2]])]; });
    } else if (a[0] === 'repo' && a[1] === 'view') {
      print(opt('-q') === '.defaultBranchRef.name' ? 'main\n' : 'me/app\n');
    } else if (a[0] === 'issue' && a[1] === 'comment') {
      // state.commentFails: a comment whose body starts with it fails
      withStdin((body) => {
        if (s.commentFails && body.startsWith(s.commentFails)) { printErr('HTTP 502: Bad Gateway'); exit(1); }
        mutate((cur) => { cur.comments.push({ issue: Number(a[2]), body, author: LOGIN, createdAt: new Date().toISOString() }); });
      });
    } else if (a[0] === 'issue' && a[1] === 'close') {
      mutate((cur) => {
        const i = find(cur, a[2]);
        i.state = 'CLOSED';
        i.closedAt = new Date().toISOString();
        i.stateReason = /not.planned/i.test(opt('--reason') ?? '') ? 'NOT_PLANNED' : 'COMPLETED';
        if (opt('--comment')) cur.comments.push({ issue: Number(a[2]), body: opt('--comment'), author: LOGIN });
      });
    } else if (a[0] === 'release' && a[1] === 'view') {
      // state.releases = [{ tag, title, notes, args }]; state.releaseViewFails: any error other than not-found
      if (s.releaseViewFails) { printErr('HTTP 502: Bad Gateway'); exit(1); }
      const r = (s.releases ?? []).find((x) => x.tag === a[2]);
      if (!r) { printErr('release not found'); exit(1); }
      print(JSON.stringify({ tagName: r.tag }));
    } else if (a[0] === 'release' && a[1] === 'create') {
      // records the args and the notes file's content; state.releaseCreateFails makes it fail
      if (s.releaseCreateFails) { printErr('HTTP 422: Validation Failed'); exit(1); }
      if ((s.releases ?? []).some((x) => x.tag === a[2])) { printErr('a release with the same tag name already exists'); exit(1); }
      const notes = opt('--notes-file') ? readFileSync(path.resolve(cwd, opt('--notes-file')), 'utf8') : undefined;
      mutate((cur) => { (cur.releases ??= []).push({ tag: a[2], title: opt('--title'), notes, latest: a.includes('--latest'), args: a }); });
      print(`https://github.com/me/app/releases/tag/${a[2]}\n`);
    } else if (a[0] === 'issue' && a[1] === 'create') {
      // state.createFails = k: the k-th `issue create` from now fails (1 = the next one), the ones before it succeed
      if (s.createFails && mutate((cur) => { if (!cur.createFails) return false; if (--cur.createFails > 0) return false; delete cur.createFails; return true; })) {
        printErr('HTTP 502: Bad Gateway'); exit(1);
      }
      withStdin((body) => {
        const number = mutate((cur) => {
          const n = Math.max(0, ...cur.issues.map((i) => i.number)) + 1;
          cur.issues.push({ number: n, title: opt('--title'), body, state: 'OPEN', labels: all('--label'), author: LOGIN,
            ...(cur.createHiddenReads ? { hiddenReads: cur.createHiddenReads } : {}) });
          return n;
        });
        print(`https://github.com/me/app/issues/${number}\n`);
      });
    } else {
      printErr(`fake gh: unsupported ${a.join(' ')}`);
      exit(1);
    }
  }
}

// the commands that read a body from stdin
const readsStdin = (a) => a[0] === 'issue' && (a[1] === 'comment' || a[1] === 'create'
  || (a[1] === 'edit' && a.includes('--body-file') && a[a.indexOf('--body-file') + 1] === '-'));

/** Run as a program: answer process.argv. A wrapper that imports this file (a router) calls it itself. */
export function cli() {
  const a = process.argv.slice(2);
  let body = '';
  const answer = () => {
    const r = gh(a, { input: () => body });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;
  };
  if (readsStdin(a)) process.stdin.on('data', (d) => (body += d)).on('end', answer);
  else answer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli();
