# Hx guide

Everything Hx does, command by command and setting by setting. New here? Start with the
[README](../README.md).

## About Hx

*Issues in, merged PRs out. Headless Claude Code workers on a GitHub board, native on Windows.*

A Windows-native pool of autonomous Claude Code workers for a GitHub-issues board.
Inspired by [VocanicZ/Harness](https://github.com/VocanicZ/Harness).

Every issue gets its own git worktree and a **fresh Claude session**, re-prompted until the agent
finishes (tests → PR → merge → issue closed). No tmux, no screen scraping: Hx drives
`claude -p --output-format stream-json` directly, so it runs on plain Windows (and anywhere else Node runs).

The core ideas come from [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT): GitHub issues
as the only state, the `## Blocked by` grammar, one worktree per issue, a Ralph loop ending on a
`<promise>`, and role-specific prompts. Hx's code is written from scratch.

The measurements behind these claims are in [Benchmarks](benchmark.md).

## Requirements

- Node ≥ 23.6 (runs the TypeScript directly: no dependencies, no build step)
- `git`, `gh` (authenticated), `claude`

## Install

```bash
npx github:MorphEdit/Hx install
```

Then, in your repo:

```bash
hx start
```

`hx install` runs `npm install -g` on the latest release tag (`--version vX.Y.Z` pins one), checks that `hx`
runs from PATH, runs `hx doctor` and offers the `/hx` Claude Code skill; `--force` replaces an `npm link`
of a checkout. It installs straight from GitHub (no npm registry). `hx update` does the same for the
latest release, `hx --version` prints the installed one. To work on hx itself from a clone, see
[Development](#development).

## First run

`hx start` takes a repo from nothing to a running board in one command. Each step is skipped when it is
already done:

```text
$ hx start "dark mode"
✓ node ≥ 23.6 — 24.1.0
✓ git — 2.47.1.windows.1
✓ gh logged in — as you
✓ agent CLI (claude) — 2.1.0 (Claude Code)
– agent CLI login — not checked
    fix: if not logged in yet: run `claude`, then `/login`
✓ GitHub origin — you/app
– .hx/config.json — missing
    fix: `hx start` runs `hx init` next
– board labels — missing: prd, ready-for-agent, …
    fix: `hx run` creates it
– rtdd (optional) — not installed
    fix: adds test selection per change (roleSkills rtdd): https://github.com/VocanicZ/rtdd

init: no .hx/config.json — running hx init
…

PRD: grilling the idea
…                                   (the grill session; the PRD is filed on confirm)

plan:
…                                   (hx run --dry-run: the board and what would run next)

Start 2 worker(s) now? [Y/n]

run: hx run --watch --workers 2
```

1. **doctor** — never skipped. `✓` passed, `✗` failed (with a `fix:` line for this OS), `–` informational
   or optional, `?` could not tell (offline). A required `✗` stops `hx start`; fix it and run it again.
2. **init** — runs `hx init` when `.hx/config.json` is missing (`init: already done` otherwise).
3. **PRD** — an idea (text or a `.md` file) is always grilled into a PRD. Without one, an open PRD or ready
   issue on the board counts as done; else it asks `What should hx build?`.
4. **plan** — the `hx run --dry-run` output, then `Start N worker(s) now? [Y/n]` (`--workers N`, default
   `workers` from the config). `n` stops here: run `hx run --watch` when you are ready.
5. **run** — `hx run --watch`.

`--yes` answers yes to every question. `hx doctor` runs the checks alone (exit 1 when a required one
fails), and `hx run` runs them at startup too: a required `✗` stops it before it claims anything.

## Usage

```bash
cd <your repo>
hx start "idea"         # doctor, init, grill, the dry-run plan, then hx run --watch (see First run; --yes, --workers N)
hx doctor               # check the prerequisites, each with a fix for this OS; exit 1 when a required one fails
hx health [--fix]       # one health pass: stale PRs from issue/<N> branches, agent-blocked after a passed audit
                        # (merged with ship --resume or sent back to ready-for-agent; blocked again → one health:
                        # bug issue), agent-blocked by a transient error (unblocked at most once per 24 h), gate-fix
                        # issues on a green main (closed as not planned once the last two gate runs are green at
                        # origin's head),
                        # leftover worktrees (i/a/t/p<N>, N not
                        # open, untouched 24 h), agent-working with no live session (released after stallMinutes),
                        # the environment (doctor checks, < 5 GB free); --fix repairs; exit 1 while a ✗ remains;
                        # hx status and the dashboard show the last pass, the dashboard Stats count passes,
                        # repairs and self-review findings; hx run runs the same pass when the board is idle (see selfHeal)
hx init                 # writes .hx/config.json and creates the GitHub labels; --rtdd also runs
                        # rtdd init in the repo root (commit .rtdd/), without it a hint if rtdd is installed;
                        # an unset worktreeSetup comes from the first lockfile (pnpm-lock.yaml → pnpm install
                        # --frozen-lockfile, package-lock.json → npm ci, …), an unset worktreeCopy is [".env"]
                        # when .env is git-ignored; no .gitattributes: offers one with
                        # "* text=auto eol=lf" (--yes adds it)
hx bug "status hangs"   # file a bug issue (label bug, text or a .md file; --title T); hx run triages it
hx prd feature.md       # file a PRD issue (title from the file's first "# " line)
hx grill "dark mode"    # an interactive claude session interviews you into a PRD (idea: text or a .md file),
                        # shows it and files it on confirm (--yes: no question); kept in .hx/prds/
hx issue "fix typo"     # a shorter session grills one small task into one issue, filed ready-for-agent on
                        # confirm (--bug: label bug, triaged first; --yes; --title T); kept in .hx/issues/
hx issue --file x.md    # file an issue file the same way, without a session (--bug, --title T)
hx status               # first `waiting on you: N question(s)` (each open needs-human issue: number, title,
                        # URL), then the runner, live sessions, usage window, and the board (issues opened by
                        # an untrusted account show as `untrusted` and are never claimed); after the board,
                        # each `split #` line of run.log from the last 24 h, oldest first:
                        # `split    split #4 → #5, #6 (2h10m ago)`
hx run --dry-run        # the board and what would run next, without changing anything
hx run                  # work the board until nothing is left, then exit
hx run --watch          # keep running and pick up new or unblocked work
hx run --issue 12,15    # only these issues / PRDs
hx pause [--now]        # from another terminal: stop a running hx run (see below)
hx resume               # clear a pause
hx release --dry-run    # the next version, its notes and the gate it would use (see Releases); without
                        # --dry-run it asks, then releases (--yes: no question; patch|minor|major by hand)
hx usage --by role      # recorded token usage and test time (by issue | role | model | day)
hx usage --tests        # per UTC day: median and p90 test-run and gate duration
hx usage --compare "2026-11-04 09:00"   # the runs before and after a change, side by side (see below)
hx dashboard [--open]   # a read-only page on http://127.0.0.1:4777/ (localhost only; --port N)
hx dashboard --fleet [--open]   # one page over every hx repo on this machine (alias: hx fleet dashboard)
hx fleet run --watch    # one hx run per repo in the fleet, sharing one worker cap (see Several repos)
hx install-skill        # write the /hx Claude Code skill to ~/.claude/skills/hx/SKILL.md: ask Claude Code to build with hx
hx update [--force]     # install the latest hx release, check it runs, run hx doctor
hx --version            # the installed version
```

**Did a change help?** After changing a setting (effort per role, workers, a prompt), compare the real runs
before and after it, without spending tokens on the benchmark: `hx usage --compare <time>` (an ISO time or
`"YYYY-MM-DD HH:MM"`, local time; `--from <time>` drops older runs). Per role it prints sessions, median
duration, median time outside tests (only records with `testMs`), median tokens and output tokens, cost per
session and failed sessions, from `.hx/usage.jsonl`. Per period it counts, from one paged GraphQL query over
the issues and their comments: audits PASS/FAIL and the FAIL share, first-round FAILs, issues closed (not
PRDs), gate-fix issues opened, tokens and cost per closed issue, stops by cause (timed out, not mergeable or
conflict, out of audit rounds, other), "tests fail after the rebase" retries and quality-bar rounds won and
lost (a `no verdict` round is neither), and needs-human questions asked (by when asked) and answered (by
when the owner's answer came); also the hours of runs.
Only hx's own markers count (`<!-- hx-audit -->`, `**hx:** impl stopped`, `<!-- hx-retry -->`, `<!-- hx-bar round=N -->`,
`<!-- hx-question -->`, the gate-fix label), from a trusted account; an answer is the first trusted comment after a question that is
not one of hx's own comments (`<!-- hx-` or `**hx:**` first); each line shows the change (`+12%`, `-3`), and a period with fewer than 10
closed issues is flagged as a small sample.

## Adding work to a running fleet

Leave `hx run --watch` running and file work from another terminal in the same checkout:

| You have | Use |
|---|---|
| one small task | `hx issue "fix typo"` — a short session grills it into one issue, filed `ready-for-agent` (`--bug`: a bug, triaged first) |
| a feature | `hx grill "dark mode"` (interviews you into a PRD) or `hx prd feature.md` (a PRD you wrote) |
| a bug | `hx bug "status hangs"` |

Every filing command touches `.hx/wake`, and a running `hx run --watch` re-reads the board within
seconds instead of after `pollSeconds`. The file is local to this checkout: it wakes only the runner of
this repo on this machine. It bypasses nothing — the CI gate, a pause, usage-limit holds and the
trusted-author filter all still apply to the new issue.

Each filing command ends with one line saying what happens next (after `It will be triaged.` for a bug,
`It will be decomposed into issues.` for a PRD):

| Runner | Closing line |
|---|---|
| running | `hx run (pid N) will pick it up now.` |
| running, paused or pausing | `hx run (pid N) is pausing — run  hx resume  to continue.` |
| not running | `no hx run is running — start it with  hx run --watch` |
| not running, paused | `no hx run is running and hx is paused — run  hx resume, then  hx run --watch` |

## Dashboard

```bash
hx dashboard            # http://127.0.0.1:4777/ (the next free port up to 4786 if it is taken)
hx dashboard --port 8080 --open   # another port; --open starts the default browser
```

A read-only page over `.hx/` and the board. It works with or without an `hx run` going, refreshes
`/api/state` every 5 s and the board every 30 s (one `gh issue list` per 30 s however many tabs are
open), and keeps the last data with an "offline / last updated" note when a fetch fails.

- **Waiting on you** — the open `needs-human` questions (number linked to the issue, title), from the last
  board read; "nothing waiting on you" when there are none.
- **Now** — the runner ("not running", or its pid, uptime, workers, paused/draining and the rate-limit
  window), the live sessions (issue, kind, title, turn, tokens, elapsed) and the CI gate (green/red,
  sha, when, the fix issue).
- **Board** — PRDs with their status and `closed/total done`, and the open issues with their status
  (`held (main red)` for an audited PR waiting for a green default branch).
  If `gh` fails, the error shows here and the rest of the page keeps working.
- **Stats** — tokens per day; test time (last 24 h: test share of session time, median test run, gate
  median and p90, and a chart of the median test run and gate duration per UTC day over the last 14 days);
  tokens/turns/sessions/time by PRD, role and model, and outcomes parsed
  from the run log: audit PASS/FAIL and average rounds, gauntlet rounds and FAILs, security passes and
  how many of them filed issues, gate REDs with the average RED → green time, and the median issue wall time.
- **Log** — the tail of `.hx/run.log`, newest last.

`hx run` writes every line it prints to `.hx/run.log` with an ISO timestamp; past 2 MiB the file is
rotated to `run.log.1` (one old file is kept), and the outcome numbers are parsed from `run.log.1` then `run.log`.
Usage by day groups records by their local date (the machine's time zone); the logs keep UTC timestamps.

Safety: the server binds **127.0.0.1 only**, answers only a `Host` of `127.0.0.1:<port>` or
`localhost:<port>` (no DNS rebinding), takes **GET only**, sends no CORS headers and changes nothing —
it only reads. The page is one self-contained file under a strict CSP (no external scripts, styles or
fonts), and every title, label, error and log line is rendered as **escaped text** (`textContent`,
never `innerHTML`), so an issue titled `<img src=x onerror=…>` shows as that text.

## Where the time goes

hx measures how long workers spend running tests, from the stream-json events it already logs: no hooks,
no extra sessions or tokens. A **test command** is a `Bash` tool call whose command matches one of the default
patterns (`npm test`, `node --test`, `pnpm`/`yarn`/`bun test`, `vitest`, `jest`, `mocha`, `pytest`,
`go test`, `cargo test`, `phpunit`, `rspec`, `dotnet test`, … — `src/timing.ts`), the repo's effective gate
command (`gateCommand`, else the one learned in `gate.json`), or an entry of `testPatterns`. Tests run through a
script (e.g. `node scripts/check.mjs`) are not counted unless the repo adds a pattern for it.

- Each turn's `UsageRecord` in `.hx/usage.jsonl` gets `testMs` (the test commands' time, overlaps merged,
  clipped to the turn), `testRuns` and `testFailedRuns` (an error result or a non-zero exit code). Older records
  have none of them and show as `-` (unknown), never 0.
- `hx usage` adds the columns `test` (total test time), `test %` (its share of session time) and `runs`;
  `hx usage --tests` prints, per UTC day, the median and p90 test run and gate duration.
- `hx status` prints a time line over the last 24 h:
  `time     tests 31% of session time · median test run 2m10s · gate 4m05s (p90 5m30s)`.
- The dashboard's Stats show the same numbers for the last 24 h and a chart of the median test run and gate
  duration per UTC day over the last 14 days.
- Every pool gate run is recorded in `.hx/gate-runs.jsonl` (see Files). `hx run` logs
  `gate is slow: median … of a … timeout — tests may time out under load` once when the median of the last 5
  gate runs is above 70% of `gateMinutes`.

## Several repos

One `hx fleet run` works several repos at once, under one shared worker cap. The fleet is a list of
repo roots in `~/.hx/fleet.json`; each repo keeps its own `.hx/` (config, logs, pause, wake).

```bash
hx fleet add [<path>]     # add the hx repo containing <path> (default: here); it needs a .hx/config.json
hx fleet remove <path>    # drop it from the fleet (its .hx/ is untouched)
hx fleet forget <path>    # drop it from ~/.hx/repos.json, the repos hx init / hx run have seen
hx fleet list             # the repos, and whether each root still exists
hx fleet workers 3        # the cap shared by every repo (default 2), read by the next hx fleet run
hx fleet run [--workers N] [--watch]
hx fleet status           # hx status for every repo, then the slots in use and the shared hold
hx fleet dashboard [--port N] [--open]   # = hx dashboard --fleet: every repo of fleet.json and repos.json
```

- `hx fleet run` starts one `hx run` per repo as a child process and prints its output prefixed
  `[owner/name]`. A repo whose root is missing, has no config, or already has an `hx run` is skipped
  with one line.
- **Shared worker cap.** Every session takes one of N file slots in `~/.hx/fleet/slots` before it
  starts and gives it back when it ends, so all repos together run at most N sessions (`--workers`,
  else `hx fleet workers`). A slot left by a runner that died is taken over.
- **Shared usage hold.** A usage limit is per account, not per repo: when one runner hits it (or its
  usage window passes `usagePauseAt`), it writes `~/.hx/fleet/hold.json` and every other runner stops
  claiming until the same time. `hx fleet status` shows the hold.
- **Shared GitHub hold.** The GitHub API budget is per account too: a runner whose budget falls below
  `ghReservePct` writes `~/.hx/fleet/github-hold.json`, and every other runner claims nothing until its
  reset. `hx fleet status` shows it next to the usage hold.
- **Ctrl+C** in `hx fleet run` asks every repo to checkpoint, exactly like Ctrl+C in `hx run`; twice
  force-quits them all. `hx pause` / `hx resume` still work per repo.
- **Dashboards.** `hx dashboard` shows one repo: run one per repo, on different ports
  (`hx dashboard --port 4778` in the second repo; without `--port` the next free port is taken).
  `hx dashboard --fleet` serves one page for all of them: `/api/fleet` (each repo's runner, sessions,
  gate, tokens and board counts, the slots in use and the hold) and each repo's own dashboard under
  `/repo/<k>/`.
- **Fleet dashboard.** `hx dashboard --fleet [--port N] [--open]` (or `hx fleet dashboard`) opens one
  page over every repo in `~/.hx/fleet.json` and `~/.hx/repos.json` (the repos `hx init` / `hx run`
  have seen; `hx fleet forget <path>` drops one). At the top, the fleet line: slots in use / the cap and
  the shared hold (until when, why, which repo), then a tokens-per-day chart over all repos. Below, one
  card per repo, running ones first: pid and workers, current sessions, paused state, gate, the last
  rate-limit reading, tokens today / total and the board (ready, working, blocked, PRDs open). Each card
  links to that repo's full dashboard; a repo whose root is gone shows "missing". With no repos the page
  says how to add one. It refreshes every 5 s, is read-only (GET only) and listens on localhost only.

## Agent CLIs

Everything hx knows about the agent CLI it drives — the argv of one headless turn, parsing its output
(result, tokens, usage-limit events) and the interactive argv for `hx grill` / `hx issue` — sits behind
one interface, `AgentCli`, in `src/agents/`. The `agentCli` config key picks the adapter by name.
`claude` (`src/agents/claude.ts`) is the only adapter today; another CLI is a new file there plus one
`registerAgent` call in `src/agents/index.ts`.

## Stopping and resuming

| You do | Hx does |
|---|---|
| `hx pause` | claims nothing new; running sessions finish their issue, then `hx run` exits |
| `hx pause --now`, or Ctrl+C in `hx run` | stops every running session, then resumes each one for a **checkpoint**: commit and push its WIP, and post a `<!-- hx-handoff -->` comment (done / left / next step). The issue is handed back. |
| nothing: an impl turn times out (`turnTimeoutMinutes`) | while the issue is still open, the session gets the same **checkpoint**; then hx commits what is left (`wip: checkpoint (#n)`), and the WIP is pushed to `issue/<n>` (never a force push), with a handoff note of hx's own when the checkpoint posted none. Then the issue is narrowed to what its WIP has nearly done and the rest filed, and it is `ready-for-agent` again, the worktree kept (see [the split after a timeout](#single-issues)). If the push fails, the issue is labelled `agent-blocked` and the comment says so: the WIP is then only in the kept worktree. |
| `hx resume`, then `hx run` | picks the issues up again: the worktree and branch still hold the work, and the new session's prompt includes the handoff note |
| Ctrl+C twice | force-quits and kills every session; the worktrees keep whatever was written |

While paused, `hx run` refuses to start until `hx resume`. Only one `hx run` per repo can run at a time.

**Leftover processes:** a turn that is stopped, times out, stalls or fails kills the agent's whole process tree
(`taskkill /T /F` on Windows, the process group elsewhere), then every process whose command line names a path in the
session's worktree: a test run whose parent shell has already exited is no longer in the tree. At `hx run` start, and
before each health pass, the same sweep runs for every directory under `worktreeRoot` with no live session, one line
per directory: `health: killed N leftover process(es) in i285`. Nothing outside `worktreeRoot` is touched, nor the
runner or its parents.

**Self-update:** with `selfUpdate: true` (off by default; `hx init` asks when hx runs from a git checkout), `hx run --watch`
keeps its own hx install up to date. At most every `selfUpdateMinutes` (default 15), and only while no session runs,
nothing is claimed and `.hx/pause` is absent, it checks for newer code:
- **a git checkout** (an `npm link` of a clone): `git fetch`; when `origin/<default>` moved and the diff touches
  `src/`, `bin/`, `scripts/`, `package.json` or the lockfile, it fast-forwards the checkout (`git merge --ff-only`,
  never a reset), running `npm ci` only when the lockfile changed. A checkout with local changes, local commits, or
  on another branch is left alone, with one line in the run log per reason. A change to `prompts/` only is no
  reason to restart: prompts are read fresh for each session.
- **a release install:** the same lookup and install as `hx update`.

Then it starts a new runner with the same arguments and exits once that one is ready: the new runner takes over the
run lock (`.hx/live.json`) and writes `.hx/selfupdate-ready` when its first poll begins; the old one claims nothing
meanwhile. A new runner that exits early or is not ready within 120 s is killed and **rolled back**: the checkout goes
back to the old commit (`git checkout <old sha>`, detached), or the old release is reinstalled; the old runner carries
on, and that sha (or tag) is never tried again, while a newer one is. No issue is filed. The run log gets
`self-update: 3f2a1c0..9b8e7d6 (4 files)`, then `self-update: restarted — pid 4242 took over` or
`self-update: rolled back to 3f2a1c0 (exited with code 1 before it was ready)`, and `hx status` shows the last one
(`update   2h ago — self-update: restarted — pid 4242 took over`). The new runner is detached from the terminal:
Ctrl+C there no longer reaches it, so stop it with `hx pause`. It is off under `hx fleet run`.

**The watch window:** new code that starts fine can still misbehave, so for `selfUpdateWatchMinutes` (default 30) after a
self-update from G to N the new runner is watched (`{ from, to, until }` in `.hx/selfupdate.json`). It is rolled back
to G when, inside the window, the runner crashes: it exits non-zero (an error in its loop, or a setup Claude rejects:
it rolls itself back and starts G), or it dies leaving its run lock behind (`hx supervise` or the next `hx run --watch`
rolls back first and then starts G). `hx supervise` follows a runner a self-update started, though it is not its parent,
through `.hx/exit.json`, where every `hx run --watch` records its exit code; a runner stopped by `hx pause` is never
rolled back. `selfUpdateFailLimit` (default 3) sessions in a row end
with an agent or hx error (a FAIL verdict, a timeout or a usage limit does not count; a success ends the streak), or the
first gate run at N itself is red while the same command is green at G (it is re-run there; red at both means the
default branch was red already, and its gate-fix issue handles it). The running sessions checkpoint first, as with
`hx pause --now`; then the checkout goes back to G (detached), a runner on G takes over, N is never tried again (a
newer sha is), and the run log gets `self-update: rolled back 9b8e7d6 → 3f2a1c0 (3 sessions in a row ended with an error)`.
A window that passes cleanly logs `self-update: 9b8e7d6 is good`. No self-update is tried while the window is open.
`hx status` shows the open window (`watch    watching 9b8e7d6 for 12 more min …`) and the last rollback with its reason.

**A crashed run** (terminal closed, machine rebooted, process killed) leaves `agent-working` on its
issues. The next `hx run` sees that the previous runner is gone and hands those issues back first.

**Broken branch refs:** a crash mid-write can leave a loose `issue/N`, `hx/prd-N` or `hx/audit-N` ref
that is not a sha (NUL bytes). At startup `hx run` deletes it and recreates the branch at
`origin/<branch>` (as last fetched); with no remote branch it removes the branch's worktree and warns
that unpushed work may be lost (`git fsck --lost-found`). Packed refs and `hx/gate` are never touched.

**Usage limits:** Hx reads Claude's usage-window events. Once a window is `usagePauseAt` full (90% by
default), it claims nothing new until the window resets; running sessions carry on. If a session hits
the limit anyway, its issue is handed back and picked up again after the reset.

**GitHub budget reserve:** Hx reads the GitHub API budget (`gh api rate_limit`, which costs nothing).
While the `core` or `graphql` bucket has less than `ghReservePct` of its limit left (20% by default), it
claims nothing new, engine steps included, and stops reading the board until that bucket resets; running
sessions carry on, the rest of the budget stays for them. The run log gets one line per reset, e.g.
`github budget low: graphql 812/5000 — no new claims until 22:41`, and `github budget restored` once the
budget is back (after the reset, or earlier if GitHub raises it). While low it wakes every
2 × `pollSeconds` to re-read the budget; without `--watch` it waits instead of finishing.
`ghReservePct: 0` turns the reserve off.

**GitHub rate limits:** every runner and every worker uses the same one `gh` login, so they all share one GitHub API
budget. Hx reads it with `gh api rate_limit` and shows it as the `github` line, e.g.
`github   core 4123/5000, graphql 4800/5000 (resets 22:41)` (the reset of the bucket with less left): `hx status` reads
it itself, the dashboard's Now section shows the running `hx run`'s last reading, and `hx fleet status` prints it once
for all repos. Below `ghReservePct` the reserve above applies (no claims, no board read, a wake every 2 × `pollSeconds`
until the reset); in a fleet the runner also writes `github-hold.json`, and every other runner backs off until the same time.
During `hx run` a `gh` call hx makes that hits a rate limit waits and is retried:
a primary limit until the bucket's reset (60 s when the budget cannot be read), a secondary limit for its
`Retry-After` (else 60 s, doubled for each further limit in a row, up to 15 min). The runner is budget-low
meanwhile (no new claims, `github-hold.json` in a fleet) and logs `github rate limited — waiting until 22:41`
once. Ctrl+C ends the wait without a retry. Every other command (`hx status`, `hx run --dry-run`, `hx issue`, …)
fails at once, as before. The worker scripts (`ship.mjs`, `issue.mjs`) wait out short limits by the same rules,
one stderr line per wait, but at most `HX_GH_WAIT_MAX_SECONDS` (default 90) per run: their shell call is killed after
a few minutes. A wait that would pass the cap is not started; the script prints `rate limited until 22:41` and fails
with its usual code.

**Budget gate:** every usage-window reading is kept in `.hx/usage-readings.jsonl`. Once a window has
`budgetMinPairs` pairs of rising readings, each with the usage cost spent between them, it is calibrated:
Hx knows roughly how many dollars 1% of it costs. Before claiming a session it forecasts the session's
share of each calibrated window from past sessions of the same role, and skips the action for now when
the forecast would take a window past `usagePauseAt`; actions further down that fit are still claimed,
and the skipped one is looked at again on the next poll (a new reading or a reset may let it through).
The run log gets one line per action per window reset, e.g.
`budget: not starting #12 review — needs ~7% of five_hour, 85% used, cap 90%`, and `hx run --dry-run`
shows each planned action's forecast (`~7%`) and marks the ones the gate would skip. With too little
history (an uncalibrated window, fewer than three past sessions) Hx claims as it did without the gate;
`budgetGate: false` turns it off.
`hx status` prints one line per window from those files, runner or not, e.g.
`budget five_hour: 85% used, $0.42 per 1% (n=12 pairs)` or
`budget seven_day: 40% used, uncalibrated (n=2 pairs, needs 5)`; a running `hx run` keeps the same
windows in `live.json` (`budget.windows`) and the dashboard's Now section shows the lines.

### Starting at logon

`hx run --watch` lives only as long as its terminal. Two commands keep it up without one:

- **`hx supervise [--workers N]`** runs `hx run --watch` (same arguments, this repo) as a child and restarts it
  when it crashes or is killed, after 10 s, 30 s, 60 s, then 5 min; a run that stayed up 30 min resets the
  backoff. When the runner exits 0 (`hx pause`, Ctrl+C) the supervisor exits too: it never restarts a runner a
  person stopped. While `.hx/pause` exists it starts nothing and waits for `hx resume`; while another live
  runner holds the run lock (`.hx/live.json`) it logs that once and waits, never starting a second one. After
  5 crashes in 10 min it logs `supervise: gave up after 5 crashes in 10 min` and exits non-zero. Its lines go to
  `.hx/run.log` (`supervise: started …`, `supervise: runner exited <code>, restart in <s>`,
  `supervise: stopped: paused …`); `hx status` and the dashboard show `supervised` and the last one.
- **`hx service install [--workers N] | uninstall | status`** (Windows) registers one Task Scheduler task,
  `hx\<repo name>-<hash of the repo path>` (two clones get two tasks), that runs `hx supervise` in this repo **at
  your logon**: never at boot, as you, with no stored password and no elevation. `install` replaces a task of the
  same name, `uninstall` removes only it, `status` shows the task, its last result, and whether a supervisor and a
  runner are alive. On macOS and Linux it prints the launchd agent or systemd `--user` unit and the commands to
  install it, and changes nothing.
- **`autoStart`** (`.hx/config.json`, default `false`; `hx init` asks on Windows) keeps that task in step with the
  setting, so there is no command to remember. At its start `hx run` looks up this repo's task: with `autoStart: true`
  and the task missing or pointing at another path, it registers it as `hx service install` does (logon trigger, you,
  least privilege, no stored password); with `autoStart: false` and the task there, it removes it as
  `hx service uninstall` does. Only this repo's task is ever touched, never another's. Each change logs one line,
  `autoStart: registered hx\<id>` or `autoStart: removed hx\<id>`. `hx doctor` shows `autoStart — on (task registered)`,
  `on (task missing — hx run will register it)` or `off`; the dashboard shows the setting and the task as `hx run`
  last found it (read-only: change it in `.hx/config.json`). A task you registered with `hx service install` while
  `autoStart` is `false` is removed by the next `hx run`: set `autoStart: true` to keep it. On macOS and Linux,
  `autoStart: true` makes `hx run` print the launchd or systemd unit once, as `hx service install` does there, and
  changes nothing.

## PRD flow

Write what you want as a PRD (a markdown file: goal, requirements, acceptance criteria) and file it
with `hx prd`. `hx run` then takes it all the way — `gauntlet → decompose → building → review → security → bar → done`:

```
PRD #20 [prd] ──gauntlet──▶ [prd-hardened] ──decompose──▶ child issues [ready-for-agent], each ending in
                                                    ## Blocked by  (#n / None)   and   ## Parent  #20
     │
     ├─ children are implemented in parallel, in dependency order (one session each)
     │
     ├─ all children closed ──review──▶ gaps found → gap issues filed → implemented → review again
     │                                  no gaps    → label prd-reviewed
     │
     ├─ reviewed + all children closed ──security──▶ findings → security issues filed, prd-reviewed removed
     │                                                  → implemented → review again → security again
     │                                               none     → label security-reviewed
     │
     ├─ security-reviewed + a `## Quality bar` section ──bar──▶ lost → one gap issue, prd-reviewed and
     │                                                          security-reviewed removed → implemented
     │                                                          → review → security → the next round
     │                                                won / cap / no verdict → label quality-bar-passed
     │
     └─ security-reviewed (+ quality-bar-passed when the PRD has the section) ──▶ Hx closes the PRD
```

- The gauntlet runs before decompose, one round per session: an independent critic reads the PRD and
  the code; on FAIL a reviser rewrites the body to resolve its findings (the original body is kept once in
  a `<!-- hx-prd-original -->` comment). Every round posts a `<!-- hx-gauntlet -->` comment. A PASS, or
  `gauntletRounds` rounds, labels the PRD `prd-hardened`. A PRD that already has children never goes back.
- A PRD's own `## Blocked by` sequences PRDs: nothing of PRD #21 runs until #20 is closed.
  PRDs without blockers run in parallel.
- Every review posts a `<!-- hx-review -->` comment on the PRD. After `reviewRounds` reviews
  without a sign-off, Hx labels the PRD `agent-blocked` for a human.
- The security pass checks only what the PRD merged (injection of GitHub text into a shell or prompt,
  path traversal, leaked secrets, unsafe deletion, new endpoints or downloads, unguarded prompts,
  new dependencies) and files one `security` issue per real finding. Every pass posts a
  `<!-- hx-security -->` comment; a pass that neither signs off nor files fails the PRD (`agent-blocked`).
  After `securityRounds` passes that each filed issues, Hx labels the PRD `agent-blocked` for a human.
- The quality bar is opt-in per PRD, with a section the decomposer leaves alone (it is not a task):

      ## Quality bar
      Beat: <named product> — <URL>
      Judged on:
      - <2–4 dimensions>

  A PRD without it closes as above. With it, a round runs once the review finds no gap and the security
  pass (when `security` is on) has signed off. Both sessions of a round run as role `bar` (effort `high`
  unless `roleModels.bar` says otherwise):
  1. **Provision**: fetch, install or launch the reference under `.hx/bar/<prd>/ref/`. If it cannot be
     (paywall, no public build, needs a credential), hx comments what failed and signs off on the criteria.
  2. **Run**: one fixed task list from the `Judged on` dimensions, run in the same order against ours and
     the reference, recorded into `.hx/bar/<prd>/r<N>/A` and `/B`. hx, not the session, picks at random
     which side is A each round and writes it to `.mapping` next to `A/` and `B/`, never inside them.
  3. **Judge**: a fresh session reads only those two directories and replies with two lines,
     `winner: A|B` and `gap: <one sentence>` — no scores. A reply in any other shape is retried once on
     the same recordings; a second failure concedes the round as `no verdict` and signs off.
  4. **Resolve** through `.mapping`: **won** → sign off; **lost** below `barRounds` → one
     `ready-for-agent` gap issue (a child of the PRD), `prd-reviewed` and `security-reviewed` removed, no
     sign-off; **lost at the cap** → no gap issue, a cap comment naming the standing gap, then sign off.

  Sign-off is the `quality-bar-passed` label; the next poll closes the PRD. Every round posts a
  `<!-- hx-bar round=N -->` comment (won, lost with the gap and its issue, or `no verdict`). Rounds are
  counted from those markers by trusted accounts only (the gh login plus `trustedAuthors`); one by any
  other account never counts. `reviewRounds` counts only the reviews after the latest bar marker, so each
  review a lost round triggers gets the full `reviewRounds`. The bar never blocks a PRD.
- A part of a PRD only a person can do (a decision, a key or login, a check by hand) is filed as a
  `[needs you]` issue labelled `needs-human`, blocking no sibling; the PRD stays `building` until it is
  answered. See [When hx needs you](../README.md#when-hx-needs-you).
- Decompose, review and security sessions only file issues, labels and comments; they never push code.

## Single issues

**An issue is picked up** when it is open, labelled `ready-for-agent`, not labelled `agent-working`
or `agent-blocked`, and every issue listed under its `Blocked by` heading is closed:

```markdown
## Blocked by
#12
other-owner/other-repo#3
```

Write `None` under the heading (or leave it out) for an issue with no dependencies.

**The size check.** A single issue is sized once, up front, before its first impl session: one `size` session
(`prompts/size.md`, mode `up-front`, run as the `decompose` role: its model, effort and skills, its turns recorded
as `decompose` in `usage.jsonl`) reads the issue and the code it names in the new impl worktree, changes nothing,
and answers `SIZE: fits` or `SIZE: split` with two or more `=== CHILD k: <title>` blocks, each about one session of
30–45 min of work. Only an issue with no parent in any form (`## Parent`, `## Parent #N`, `Parent: #N`, `Part of #N`),
not labelled `bug` or `hx-gate-fix`, on a new impl worktree (not resumed) and without a size marker is sized.
The markers are comments whose first line is `<!-- hx-size fits -->`, `<!-- hx-size split -->` or
`<!-- hx-size narrowed -->`; only those written by hx's own gh login count (not `trustedAuthors`).
- **fits:** hx comments `<!-- hx-size fits -->` and `**hx:** sized: fits one session.`, logs `size #n: fits`, and the
  impl session starts in the same worktree.
- **split:** hx reads the open issues `Blocked by` #n, files the children `ready-for-agent` with `## Blocked by`
  (the earlier children the reply names, or `None`) and `## Parent #n`, adds the children to those dependents'
  `## Blocked by`, comments `<!-- hx-size split -->` and `**hx:** split into #a, #b, … — each about one session; the
  work continues there.`, closes #n as not planned, removes `agent-working` and the worktree, and logs
  `split #n → #a, #b`. No impl session runs for #n.
- **the session fails** (an agent error, no promise after `maxIterations`, a reply in no valid shape, or the
  dependents cannot be read): hx comments `<!-- hx-size fits -->` and `**hx:** size check failed (<reason>); treated
  as fits.` and implements the issue. It is never retried and never blocks.
- **a GitHub write fails partway through a split:** hx writes nothing more and labels #n `agent-blocked` (worktree
  kept); the fail comment starts with `<!-- hx-size split -->` and says where it stopped and what was filed, so the
  issue is never sized again. Finish or undo the split by hand.
- **stopped** (`hx pause --now`, a usage limit, a setup error): the issue is handed back with no marker and the fresh
  worktree is removed, so the next claim sizes it again.

`sizeCheck: false` turns the up-front check off.

**The split after a timeout.** When an impl turn times out (`turnTimeoutMinutes`, plain or audited) while the issue
is still open, its WIP is checkpointed and pushed to `issue/<n>` (see [Stopping and resuming](#stopping-and-resuming)).
Then one `size` session in mode `after-timeout` runs in the kept impl worktree: it reads the issue, the handoff note
and `git diff origin/<base>...HEAD`, and answers `SIZE: narrow` with one `=== SCOPE` block (what the WIP has nearly
done) and zero or more `=== CHILD k: <title>` blocks (the rest). This is always on, whatever `sizeCheck` says.
- **narrow:** hx reads the open issues `Blocked by` #n, files the rest `ready-for-agent` with `## Blocked by` #n first
  (then the earlier rest issues the reply names) and `## Parent` #n's own parent when it has one in this repo (the rest
  of a PRD child stays that PRD's child), otherwise #n; adds them to those dependents' `## Blocked by`; rewrites #n's
  body to a `## Scope (narrowed after a timeout)` heading, the line `Narrowed by hx after a <turnTimeoutMinutes>-min
  timeout; the rest is #a, #b.`, the SCOPE text, #n's old `## Blocked by` and its `## Parent`; comments
  `<!-- hx-size narrowed -->` with the rest issues and the previous body in a `<details>` block; removes
  `agent-working` and `agent-blocked`, keeps `ready-for-agent` and the worktree, and logs
  `split #n → #a, #b (narrowed after a timeout)` (`split #n → none (narrowed after a timeout)` when nothing was filed).
  The next impl claim resumes the kept branch with the latest handoff note.
- **once only:** a second timeout on an issue that already has a `<!-- hx-size narrowed -->` marker by hx's login
  ends in `agent-blocked` (`the turn timed out again; this issue was already split once after a timeout`). An up-front
  `fits` does not count.
- **the session fails** (an agent error, no promise, a reply in no valid shape, or the dependents cannot be read):
  `agent-blocked`, with no narrowed marker; the comment says the WIP is on `issue/<n>`, and run.log has
  `not narrowed after the timeout: <reason>`.
- **a GitHub write fails partway:** hx writes nothing more and labels #n `agent-blocked` (worktree kept); the fail
  comment starts with `<!-- hx-size narrowed -->` and says where it stopped and what was filed, so a later timeout
  is not narrowed again. Finish or undo the split by hand.
- **stopped** (`hx pause --now`, a usage limit, a setup error): the issue is handed back, the worktree kept.

## When a task needs you

A worker that hits a point only the owner can settle (a decision with no sensible default, the owner's own
key, sign-up or login, a check by eye or by hand) does not guess. It commits and pushes its work so far and ends
its session with one plain-language question (lettered choices, one marked recommended) and
`<promise>NEEDS_HUMAN <n></promise>` on the last line. That is not a completion: hx verifies nothing, looks for no
PR and runs no audit. Under `maxOpenQuestions` open `needs-human` issues, hx posts the question as a comment
starting with `<!-- hx-question -->` (the promise line removed), swaps `ready-for-agent` and `agent-working` for
`needs-human`, and keeps the worktree and branch. Answer it in one comment (for example `A`); the next poll makes
the issue `ready-for-agent` again and the next session resumes the kept branch with the question and your answer.
At the cap, hx posts no question: it comments `**hx:** too many open questions; the next session takes the
recommended choice`, keeps the worktree and puts the issue back to `ready-for-agent`; that session's prompt says
the cap is reached. The count and the relabel run one at a time, so two sessions that stop together cannot both
pass at the last free place. hx's own comments (`<!-- hx-` or `**hx:**` first, the cap comments among them) are
never taken as your answer: an issue put back at the cap gets a prompt that says you were not asked and to note
the recommended choice under `## Decisions made for you`; a reply you post later is still your answer. Anything with a sensible default the worker decides itself and lists in the PR
body under `## Decisions made for you`.

## Every PR is audited before it merges

The implementer never merges its own work. It ships with `ship.mjs --no-merge` and stops at an open PR.
The one exception is an owner's answer that leaves nothing to build: the implementer closes the issue with a
comment and opens no PR, and that counts as done. A closed issue whose branch has a PR in any state (a PR the
implementer merged itself, never audited) is not that case: it fails and is labelled `agent-blocked`.
Then a **separate auditor session**, in its own fresh checkout of the pushed branch, checks the PR
against the issue — every rule and example, by reading the code and running the cases itself, and
whether the new tests would fail if the feature were wrong. It reads the whole change in context: the issue
and its parent PRD, every changed file in full, the callers of the changed code, and the parts of
`CLAUDE.md`, `docs/design.md` and the README the change touches. It answers `VERDICT: PASS` or `FAIL`
with findings, posted on the issue: a FAIL lists the defects, a PASS lists every acceptance criterion with
its evidence (the file and line, the command run and what it printed).

```
implement ──▶ PR open ──▶ audit ──PASS──▶ hx rebases, re-tests, merges, closes the issue
                 ▲                  │
                 └── findings ◀─FAIL┘   (after auditRounds FAILs: agent-blocked, for a human)
```

## CI gate

After every merge (and when `hx run` starts) Hx runs the project's test command on a fresh checkout of
the default branch. If it fails, Hx files one `hx-gate-fix` issue with the output and **claims nothing
else** until a later run is green — no worker builds on a broken base. The command is `gateCommand`,
or the test command the first audited merge used. `hx status` shows the gate.

A hung test run cannot block anything: `ship.mjs` gives the tests `--test-timeout` minutes (default 45,
remembered for `--resume`) and the gate `gateMinutes` (default 45); past that the whole process tree is killed and the
run counts as failed (exit 4 / a red gate marked "timed out").

**A held merge.** When an audited PR's merge fails its tests after the rebase, Hx first takes the gate's
result for the default branch as it is now (testing it again when it has moved since the last run). If
the gate is red and every failing test it can name in the PR's run also fails on the default branch, the
PR is not at fault: its PASS stands, no audit round is counted and no implementer runs. Hx comments once
(`<!-- hx-merge-held -->`: "held: main is red (#<gate-fix issue>); merges once main is green"), records it
in `.hx/held.json` and releases the issue; `hx status` and the dashboard show it as `held (main red)`. On
the first poll after the gate turns green the merge is retried, and only the merge. Any failing test not
on the default branch's list (or none that can be named, or a green gate) sends the PR back to the
implementer as before, the message naming the tests the branch broke; so does a rebase conflict on the retry.
Test names are read from node's spec and TAP reporters, jest, pytest and go test output.
Claude Code caps one shell command at 10 minutes, so each session gets `BASH_MAX_TIMEOUT_MS` and
`BASH_DEFAULT_TIMEOUT_MS` of ship's test timeout + 5 min (kept below `turnTimeoutMinutes`; a higher value
already in the environment is kept), and the stall timer waits as long while a tool call runs. A PR opened
outside ship is still merged after the audit: `ship --resume` rebuilds its state from the branch's PR.

## Releases

```bash
hx release [patch|minor|major] [--dry-run] [--yes]
```

`hx release` tags the next version of the default branch and publishes its GitHub release.

- **The version.** The current version is the highest `vX.Y.Z` tag on origin (local tags never count),
  else `version` in `package.json` on the default branch, else `0.0.0`. The bump is `minor` when a PRD
  closed (as completed) since the last tag, else `patch`; `major` is only ever chosen by hand, like any
  bump given on the command line. With no commit since the last tag: `nothing to release since vX.Y.Z`.
- **A green gate first.** The release is made only on a green CI gate for the default branch: the
  recorded result when it is for origin's head, else a fresh gate run of `gateCommand` (or the learned
  command) — even when `gate` is off. That run is never recorded: `gate.json` is untouched and no fix
  issue is filed. With no command known it stops with `no gate command known: set gateCommand` (exit 1);
  a red or timed-out gate prints its output and exits 1. `hx release` refuses while `hx run` is running
  for the repo (`hx is already running for this repo (pid N)`, exit 3): stop it first, or set `autoRelease`.
- **The atomic push.** In a worktree on the gated commit, `package.json` gets the new version
  (`chore: release vX.Y.Z`), the commit gets an annotated tag, and both go to origin in one `--atomic`
  push. If the default branch moved on in the meantime the push is rejected, and there is no rebase (a
  rebased commit would hold ungated changes): the tag goes on the gated commit itself and `package.json`
  is not bumped — `package.json was not bumped (push rejected): tagged vX.Y.Z at <sha>`. A repo with no
  `package.json` gets only the tag.
- **A missing release.** When the last tag on origin has no GitHub release (say `gh release create`
  failed after the push), the next `hx release` makes only that release, from that tag's own range, and
  prints `created the missing release vX.Y.Z`. Running it again is safe: nothing is pushed twice.
- **The notes** are built from git and GitHub, with no AI and no changelog file: one `PRD #N: <title>` line
  per PRD closed in the range, then `## Features` (`feat:`), `## Fixes` (`fix:`), `## Docs` (`docs:`) and
  `## Other` from the first-parent commit subjects (empty groups left out, release commits skipped), each
  line ending `(#issue, #PR)` from its `closes #N` and `(#PR)`, then a `Full diff` compare link from the
  previous tag.

`--dry-run` prints the version, the notes and the gate result it would use, and changes nothing.

**autoRelease.** With `autoRelease` on, `hx run` releases by itself, the same way, after a merge, when a
PRD closes and while `--watch` waits for work: a `minor` release once a PRD closed since the last tag, and a
daily `patch` release once the last tag is older than `autoReleasePatchHours` (default 24) and a `fix:` merged since. Whether
one is due is read from origin's tags, the commits and GitHub on every check; nothing is stored. With
`gate` on it uses the run's own gate result (waiting for, or starting, a run for the head); with `gate`
off, a release-only gate run. A check never blocks claims; a failed one is retried on the next check.
The log says what happened:

```
released v1.4.0 (PRD #139)
released v1.4.1 (fixes)
release: none due — fixes merged, but v1.4.1 is less than 24 h old
```

`release: none due — …` is logged once, when `hx run` finishes; a failure logs `release vX.Y.Z failed: …`.

## Worktree setup

Every session and the gate work in a fresh `git worktree`, which holds only tracked files: no
`node_modules`, no `vendor/`, no `.venv`, no `.env`. In most projects the tests then fail before the
agent has changed anything, so the first session spends turns installing things by hand (or reports
failures that are not its own), and the gate turns red on a base that is fine. Three keys fix that:

- `worktreeSetup` — one shell command run in every new worktree, e.g. `npm ci` (`""` = none).
- `worktreeSetupMinutes` — its time limit (default 10); past that its whole process tree is killed and
  the setup counts as failed.
- `worktreeCopy` — untracked local files or folders copied from the main checkout into every new
  worktree before the command runs, e.g. `[".env", "config/local"]`. Entries are paths relative to the
  repo root: no `..`, no globs, no absolute paths (config validation refuses them). A missing entry is
  skipped; an entry git tracks is not copied (`setup: skipped <path> (tracked by git)` in the run log).
  Every copied path is added once to the repo's shared `info/exclude` (`/.env`, `/config/local`), so
  `git status` in a worktree never shows it and no session commits it.

**When it runs:** whenever hx creates a worktree: impl, audit, triage, the PRD roles (decompose, review,
gauntlet, security) and the gate. A reused impl worktree is set up again only when its last setup
did not succeed (or was interrupted). Setup runs outside the worktree queue, so a slow install never holds
up other workers.

**`hx init`** proposes the command from the first lockfile in the repo root: `pnpm-lock.yaml` →
`pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `package-lock.json` →
`npm ci`, `bun.lockb` → `bun install --frozen-lockfile`, `composer.lock` → `composer install
--no-interaction`, `poetry.lock` → `poetry install`, `uv.lock` → `uv sync`, `Gemfile.lock` →
`bundle install`, `go.sum` → `go mod download`, `Cargo.lock` → `cargo fetch`. A git-ignored `.env` in
the root goes into `worktreeCopy`. A key already in `.hx/config.json` is left alone — an explicit
`"worktreeSetup": ""` stays off. `hx status` shows both.

**On failure:** a session starts anyway; the impl, audit and triage prompts get a setup note with the
command and the last 20 lines of its output, and the agent fixes the environment first if it has to.
The gate retries a failed setup at once, up to 3 times at one sha; after the third it turns red and
files a fix issue that names the setup command (`worktreeSetup`), not the test command.

**Where the output is:** the full output of each setup in `.hx/logs/setup-<name>.log` (`<name>` is the
worktree: `i12`, `a12`, `t12`, `p12`, `gate`), one line per setup in the run log (`[#12] setup: npm ci
(42s)`, `[#12] setup FAILED (exit 1): …`, `gate: setup FAILED (exit 1, try 2 of 3): …`), and for
session worktrees the last result in `.hx/logs/setup-<name>.json`, which decides whether a reused
worktree is set up again.

A setup command that rewrites tracked files (a lockfile an install updates) leaves those changes in the
worktree, where the session sees them as its own. Use frozen installs — `npm ci`, `--frozen-lockfile` —
which never rewrite the lockfile; that is the guard.

## Line endings

Every file hx works on is LF. A checkout on Windows is CRLF when git's `core.autocrlf` is `true` (Git for
Windows sets it), and CRLF has broken work before: diffs that touch every line, rebases that conflict on
lines nobody changed, tests that compare file text. So:

- Every worktree hx creates (impl, audit, triage, the PRD roles, self-review, the gate) is checked out with
  `core.autocrlf=false` and `core.eol=lf`, and keeps both in its own config (`git config --worktree`,
  with `extensions.worktreeConfig` set in the repo). Your global and system git config are never changed.
- `hx init` offers a `.gitattributes` with `* text=auto eol=lf` when the repo has none (`--yes` adds it);
  an existing one is never touched. Commit it, and run `git add --renormalize .` once if files were
  committed with CRLF.
- `hx doctor` shows a `–` note (never a failure) when `.gitattributes` has no `eol` rule or
  `core.autocrlf` is `true`, with the fix.
- `ship.mjs` rewrites a changed text file that holds CRLF as LF before it commits, when `.gitattributes`
  asks for LF (binary files are left alone).

## Bug lane

File a bug with `hx bug "status hangs"` (text or a `.md` file; `--title T`): it opens an issue labelled
`bug`. Before anyone fixes it, a **triage session** (`prompts/triage.md`, worktree `t<n>`) tries to
reproduce it and posts a `<!-- hx:triage -->` comment whose verdict line is `VERDICT: REPRODUCED` or
`VERDICT: NEEDS-INFO`:

```
bug ──triage──▶ REPRODUCED ──▶ bug-triaged + ready-for-agent ──▶ impl → audit → merge → CI gate
       │        NEEDS-INFO ──▶ agent-blocked (until the reporter answers)
       └─────── no verdict ──▶ hx posts VERDICT: FAILED, the next run triages again
```

- A reproduced bug is built **ahead of** feature work: the same implement → audit → merge path and
  CI gate as any issue, and its impl and audit prompts tell the worker to reproduce the bug in a test first.
- `VERDICT: NEEDS-INFO` labels the bug `agent-blocked`. Once the reporter has answered, remove
  `agent-blocked` and the next `hx run` triages it again.
- A session that ends without a verdict gets hx's own `VERDICT: FAILED` marker comment; it counts as a
  round and the bug goes back to the board for a retry. After `triageRounds` rounds Hx labels it
  `agent-blocked` and comments once that triage gave up.
- Adding `bug-triaged` + `ready-for-agent` **by hand** skips triage: the bug is claimed straight away.
- `bug` on a PRD's child issue is ignored by the lane: the child is built in the PRD's order, untriaged.
- `bugTriage: false` turns triage off; a `bug` issue then needs `ready-for-agent` like any other issue.

Labels: `bug` (a bug report), `bug-triaged` (a triage session reproduced it). Config: `bugTriage`,
`triageRounds` (see below).

## Self-check

When the board runs dry, hx looks over its own state, repairs what it safely can and files the rest as work.

**When it runs.** A **health pass** runs when nothing is claimable and no session is running: in
`hx run --watch` at most once per `healthEveryMinutes` (default 60), once at the end of a plain `hx run`
before it exits, and on demand with `hx health [--fix]`. `hx health` without `--fix` only reports;
`--fix` repairs, even with `selfHeal: false`. With `selfHeal: false` the passes `hx run` starts only report,
file nothing and start no self-review. A pass never runs during a usage hold or while the GitHub budget is
low (`ghReservePct`). Every check skips an issue in a live runner's session, and reads comments from trusted
accounts only.

**The checks**, in this order; an issue one check acts on or reports is skipped by the checks after it:

1. **Stale PR** — an open PR from `issue/<N>` whose issue is closed, or that already has another merged PR:
   closed with a comment saying why. The branch is kept.
2. **Blocked after a passed audit** — `agent-blocked`, an open PR from `issue/<N>`, and the last hx audit
   comment says `PASS ✓`. A `MERGEABLE` PR is merged through the `ship --resume` path (as right after an
   audit); a `CONFLICTING` one, or a resume that exits non-zero, goes back to `ready-for-agent` with the
   reason; `UNKNOWN` waits for the next pass. Once per issue: each comment it writes carries
   `<!-- hx:health resume -->`, and an issue blocked again after one gets a `health:` issue instead.
3. **Gate-fix issue on a green main** — an open `hx-gate-fix` issue is closed as not planned once the last
   two lines of `.hx/gate-runs.jsonl` are green at the head of `origin/<default>`. With only the last one
   green there, a pass in `hx run` asks its gate for one more run (never while one runs); `hx health`
   reports `waiting for a second green gate run`. A red or empty record leaves the issue alone.
4. **Blocked by a transient error** — `agent-blocked` whose last hx comment is a stop with a transient
   reason (`stalled: no output`, `turn timed out after`, `claude exited <code> with no result`, `API 429`,
   `API 5xx`, `rate limit`; never `merging the audited PR failed`): unblocked with a comment starting
   `<!-- hx:health unblock <time> -->` (ISO UTC). Once per issue per 24 h, read from that marker.
5. **Leftover worktrees** — `i<N>`, `a<N>`, `t<N>` or `p<N>` under `worktreeRoot`, N not open, untouched
   for 24 h: removed (`git worktree remove`, then `git worktree prune`). The local branch is kept; any other
   name (`gate`, `r`, `sr`) is never touched.
6. **Stuck labels** — `agent-working` in no live session: `.hx/health.json` records when a pass first saw it,
   and a pass more than `stallMinutes` later removes the label.
7. **Environment** — the `hx doctor` checks and less than 5 GB free on the worktree drive: reported only.

**What files a `health:` issue.** Only an issue blocked again after its resume repair: one `bug` issue titled
`health: …` whose body carries `<!-- hx:health <key> -->` (`<key>` = `resume:<N>`). hx looks for the marker
among open and closed issues first, so a `health:` issue a human closed is never refiled; the bug lane fixes
and closes them. Every other ✗ waits for time or a gate run, or is about the machine, and files nothing.

**Self-review.** After a pass in `hx run` that changed nothing (`selfHeal` on, the board still empty), a
read-only `selfreview` session (`prompts/selfreview.md`, worktree `sr` on `origin/<default>`) reviews what
merged since the head recorded in `.hx/selfreview.json` (`{ sha, at }`), at most once per
`selfReviewEveryHours` (default 12) and only when that range has a commit. With no `selfreview.json`, or a
sha the head does not descend from, the first pass only records the head as a start point: the first review
covers what merges after it. It reports real defects only, each a `## Finding` block; up to
`selfReviewMaxFindings` (default 5) become `bug` issues carrying `<!-- hx:selfreview <sha> -->` and go
through the bug lane (triage → impl → audit → merge), the rest are dropped. A finished session records the
head (`self-review: no findings since <sha>` when it found none); one that did not finish records nothing.
Its model is `roleModels.selfreview`, and its turns go to `usage.jsonl` with role `selfreview`. `hx health`
never starts one.

**Where it shows.** Each pass writes one `health:` line to the run log, e.g.
`health: 3 ✓ · 1 ✗ · fixed 2 (closed stale PR #91, merged PR #171 (#170)) · filed 1 (#200)`, plus a line per
finding. `hx status` shows the last pass and how long ago it ran, the dashboard's Now shows the same line, and
its Stats count passes, repairs, filed issues and self-review findings.

**What it never does.** No direct commit to `main` (every fix goes issue → PR → audit → merge), no delete of a
remote branch or a local branch, no force push, and no other block touched: a `NEEDS-INFO` triage block, the
review / security / triage round caps, an audit that kept failing and a failed merge stay for a human.

## What happens to an issue

| Outcome | Hx does |
|---|---|
| split up front (the size check answered `split`) | files the children `ready-for-agent` (each `## Parent #n`), adds them to the `Blocked by` of the open issues waiting on #n, comments `<!-- hx-size split -->` with the list, closes #n as not planned and removes its worktree; no impl session runs (see [Single issues](#single-issues)) |
| the impl turn timed out (and the issue is still open) | checkpoint and push: the WIP goes to `issue/<n>` with a handoff note; then the issue is narrowed to what the WIP has nearly done, the rest filed `ready-for-agent` (each `Blocked by` #n), the narrowed marker posted, and the issue is `ready-for-agent` again with its worktree kept; the next session resumes the branch (see [Single issues](#single-issues)) |
| a second timeout (the issue was already narrowed once) | checkpoint and push as above, then `agent-blocked`: `the turn timed out again; this issue was already split once after a timeout` |
| the audit passes and the merge goes through | hx merges the PR, closes the issue, removes `agent-working` and the worktree |
| the audit passes but the merge's tests fail only where the red default branch fails too | held: no round counted, one `<!-- hx-merge-held -->` comment, `held (main red)` in `hx status`; the merge is retried once the gate is green (see [CI gate](#ci-gate)) |
| the audit fails | the findings go to a fresh implementer session on the same branch; after `auditRounds` FAILs: `agent-blocked` |
| no promise after `maxIterations` turns, or the agent errors | comments the reason and last reply on the issue, labels it `agent-blocked`, keeps the worktree |
| the worker needs the owner (a decision, a key, a check by hand) | commits and pushes its work, posts the question as a `<!-- hx-question -->` comment, swaps `ready-for-agent` for `needs-human`, keeps the worktree; the owner's answer (one trusted comment) relabels it `ready-for-agent` and the next worker gets the question and the answer. At `maxOpenQuestions` open questions: no question, a too-many comment, back to `ready-for-agent` |
| usage limit hit | releases the issue, stops claiming until the limit resets |
| Claude rejects the setup (API 400/401/403/404: unknown model, outdated CLI, auth) | hands the issue back untouched and stops the whole run with the reason |

Remove `agent-blocked` from an issue to let Hx try it again.

## Skills for workers

A skill is a `SKILL.md` that hx appends after a role's prompt, so a worker gets it without loading
skills itself (lean workers still run with skills loading off). `roleSkills` says which role gets
which skills; the default is `{ "impl": ["rtdd"], "audit": ["rtdd"] }`, and `{}` turns skills off.

- A skill `x` is read from the first of `<repo>/.claude/skills/x/SKILL.md`, `<home>/.claude/skills/x/SKILL.md`,
  `<repo>/.agents/skills/x/SKILL.md`. Its front matter and HTML comments are stripped; an optional
  hx note `prompts/skills/<name>.md` is appended after it.
- A skill longer than `skillMaxChars` (12000, measured after stripping) is skipped.
- Skills are resolved once per `hx run`: the run logs which role got which skills, and `hx status` shows them.
- The orchestrator itself is code and gets no skills.

Add a skill to a role only when an eval shows it helps.

### rtdd

[rtdd](https://github.com/VocanicZ/rtdd) names the tests a change needs and the changed lines no test reaches.

1. Install it: `npx github:VocanicZ/rtdd --version=v0.4.0`.
2. Run `rtdd init` in the repo (or `hx init --rtdd`).
3. Commit `.rtdd/` (`config.yaml`, `.gitignore`) — not `graph.json`, which `.rtdd/.gitignore` keeps out.

hx uses rtdd only when `rtddBin --version` works and `.rtdd/config.yaml` is on `origin/<base>`. A path
`rtddBin` must point at a file the OS resolves as `rtdd` (e.g. `rtdd`, `rtdd.exe`, `rtdd.cmd`), since only
its directory is put on `PATH`. `HX_RTDD_BIN` overrides it.

Limitations:
- `untested` can be empty for a new function in a file the tests already import — use `rtdd explain <name>`.
- Round 1 can be large when end-to-end tests import most modules.

The full suite stays the final word: `ship.mjs` runs it before every PR, and the CI gate after every merge.

## Models per role

Every session runs with `model` and `effort` unless `roleModels` gives its role its own:

```json
"roleModels": { "impl": { "model": "claude-sonnet-5-5" }, "audit": { "model": "claude-sonnet-5-5", "effort": "high" } }
```

- Roles: `impl`, `audit`, `triage`, `decompose`, `critic`, `revise`, `review`, `security`, `selfreview`, `bar`. A field left out
  falls back to the top-level one (`bar`'s effort to `high`); `effort` must be one of `low`, `medium`, `high`, `xhigh`, `max`.
- `hx run` checks `roleModels` before it claims anything and stops with the reason when it is wrong.
- A checkpoint resumes its session with that session's model; continue turns keep it too.
- `hx run` logs the roles that differ (`models: impl claude-sonnet-5-5/medium, …`), `hx status` shows them, and
  `live.json` holds the whole map as `models`.

The default is `{}`: every role on `model` and `effort`, as before. A cheaper model on `impl` or `audit`
saves tokens but can cost quality — check it with the benchmark before it becomes a default.

A turn can run on another model than it asked for (the CLI reports the one that ran; `hx usage --by model`
and the dashboard's per-model numbers use it). To spot one:

- `run.log` gets one line per session: `model mismatch: <role> asked <x>, ran <y>`; the session goes on.
- `hx status` prints `model mismatch: N session(s) — see run.log` when N > 0 (checkpoint turns and older
  usage records without the reported model never count).
- The dashboard's Stats has a **model mismatch** row next to the other outcomes.

## Config (`.hx/config.json`)

| key | default | |
|---|---|---|
| `trustedAuthors` | `[]` | accounts besides the gh login whose issues and PRDs hx works on (case-insensitive); anything opened by anyone else is skipped and shown as `untrusted` |
| `roleSkills` | `{"impl":["rtdd"],"audit":["rtdd"]}` | role → skills (`SKILL.md` from `<repo>/.claude/skills`, `~/.claude/skills`, `<repo>/.agents/skills`) appended to its prompt, resolved once per `hx run` (logged, and in `live.json`); `{}` = none. rtdd is used only when `.rtdd/config.yaml` is on `origin/<defaultBranch>` and `rtddBin --version` works; its sessions get `prompts/skills/rtdd.md` too, and a path `rtddBin` its directory first on `PATH` |
| `roleModels` | `{}` | role (`impl`, `audit`, `triage`, `decompose`, `critic`, `revise`, `review`, `security`, `selfreview`, `bar`) → `{ "model", "effort" }` for its sessions; a field left out uses `model` / `effort` (`bar`'s effort defaults to `high`; see [Models per role](#models-per-role)) |
| `skillMaxChars` | `12000` | a skill whose `SKILL.md` body (front matter and HTML comments stripped) is longer is skipped |
| `rtddBin` | `"rtdd"` | the `rtdd` command (`HX_RTDD_BIN` overrides it) |
| `workers` | 2 | sessions running in parallel |
| `minWorkers` | 1 | the floor: hx always keeps claiming up to this many sessions (unless a pause, a red gate, a usage hold, the GitHub budget or a fleet slot holds claims); a whole number from 1 to `workers`, clamped to `--workers N` when that is lower |
| `autoWorkers` | `true` | `workers` is a ceiling and the session count follows machine load; `false` = a fixed count of `workers` sessions |
| `loadHighPct` | 85 | CPU busy % at or above which the target steps down (0 to 100, above `loadLowPct`) |
| `loadLowPct` | 60 | CPU busy % at or below which, with at least `minFreeMemGB` free, the target may step back up |
| `minFreeMemGB` | 2 | free memory below this (GB = bytes / 1024³) counts as high load; `0` turns the memory check off |
| `scaleUpMinutes` | 5 | minutes of low load before one step up |
| `model` | `claude-opus-5-5` | model for every session; prefer a full id — the `opus` alias may resolve to an older Opus |
| `effort` | `medium` | `claude --effort`: `low`, `medium`, `high`, `xhigh`, `max`, or `""` for the CLI default |
| `agentCli` | `"claude"` | the agent CLI that workers, `hx grill` and `hx issue` run (an adapter in `src/agents/`); `claude` is the only one |
| `maxIterations` | 8 | turns per session before giving up |
| `maxOpenQuestions` | 3 | open `needs-human` issues (questions waiting on the owner) at once. The decompose prompt says how many `[needs you]` question issues it may still file; after a decompose session past the cap, hx gives that PRD's newest ones `ready-for-agent` instead, with a comment (the agent takes the recommended choice). An impl session that stops with `NEEDS_HUMAN` at the cap has its question dropped and the issue put back to `ready-for-agent`; the impl prompt says so when the cap is reached |
| `sizeCheck` | `true` | a single issue (no parent, not `bug` or `hx-gate-fix`) is sized by one `size` session before its first impl session and split when too big; `false` turns off the up-front check (see [Single issues](#single-issues)) |
| `gauntlet` | `true` | critique and revise a PRD in rounds before it is decomposed |
| `gauntletRounds` | 2 | critic → reviser rounds before the PRD is decomposed anyway |
| `reviewRounds` | 3 | PRD reviews before a human has to look |
| `barRounds` | 3 | quality-bar rounds for a PRD with a `## Quality bar` section; a lost round files one gap issue, and the last one signs the PRD off with the gap standing. `hx status` and the dashboard show each such PRD's round and last result (`bar round 1/3 · last: lost — <gap>`, or `bar: not run yet`) |
| `security` | `true` | a security pass checks a reviewed PRD's merged work before the PRD closes |
| `securityRounds` | 2 | security passes that file issues before a human has to look |
| `bugTriage` | `true` | a `bug` issue (not a PRD's child) is triaged before it may be claimed; until `bug-triaged` it shows as `triage`, and a triage session (`prompts/triage.md`, worktree `t<n>`) reproduces it and posts a `VERDICT: REPRODUCED` (→ `bug-triaged` + `ready-for-agent`) or `NEEDS-INFO` (→ `agent-blocked`) comment |
| `triageRounds` | 2 | triage sessions on a bug before a human has to look: a session without a verdict gets hx's `VERDICT: FAILED` marker and counts as a round; at the cap hx labels `agent-blocked` and comments once |
| `audit` | `true` | an independent auditor checks every implementation PR before hx merges it |
| `auditRounds` | 3 | implement → audit attempts before the issue goes to a human |
| `gate` | `true` | test the default branch after every merge; while red, claim only its fix |
| `gateCommand` | `""` | the gate's test command (empty: learned from the first audited merge) |
| `gateMinutes` | `45` | the gate's test run is killed, with its process tree, after this long and counts as red |
| `testPatterns` | `[]` | extra regexes (case-insensitive, matched anywhere in a worker's shell command) that mark it as a test run, on top of the defaults (see [Where the time goes](#where-the-time-goes)); an invalid one is refused |
| `autoRelease` | `false` | `hx run` releases by itself, as `hx release` does: `minor` once a PRD closed since the last tag, `patch` once the last tag is older than `autoReleasePatchHours` and a `fix:` merged since; with `gate` on it uses the run's recorded gate result |
| `autoReleasePatchHours` | 24 | how old the last tag must be before merged fixes make a patch release due |
| `usagePauseAt` | 0.9 | claim nothing new once a usage window is this full (0..1) |
| `ghReservePct` | 0.2 | claim nothing new while the GitHub API `core` or `graphql` budget has less than this share left, until it resets (0..1, 0 = off) |
| `budgetGate` | `true` | before claiming a session, skip it while its forecast would take a calibrated usage window past `usagePauseAt` (see Budget gate) |
| `budgetMinPairs` | 5 | pairs of rising usage-window readings (each with the usage cost spent between them) a window needs before its dollars-per-1% rate is calibrated and used to forecast |
| `checkpointMinutes` | 10 | time a stopped session gets to commit, push and write its handoff |
| `turnTimeoutMinutes` | 60 | wall-clock limit for one turn; above ship's test timeout, since one shell command may run ship's test timeout + 5 min (`BASH_MAX_TIMEOUT_MS`) |
| `stallMinutes` | 15 | a turn with no stdout for this long is killed (0 = off) |
| `pollSeconds` | 60 | how often the board is re-read |
| `selfHeal` | `true` | `hx run` runs a health pass when the board is idle (`--watch`: at most every `healthEveryMinutes`; a plain run: once before it exits; never during a usage hold or a low GitHub budget) and applies its repairs, asking its gate for one more run when a gate-fix issue has only one green run at the head; `false`: the pass only reports (`hx health --fix` repairs even then). Its lines go to the run log |
| `healthEveryMinutes` | 60 | minutes between `hx run --watch`'s health passes |
| `selfReviewEveryHours` | 12 | after a health pass in `hx run` that changed nothing (`selfHeal` on, nothing claimable), a `selfreview` session reviews what merged on the default branch since the head in `.hx/selfreview.json`, at most this often; its findings become `bug` issues carrying `<!-- hx:selfreview <sha> -->`. With no `selfreview.json` (or a sha the head does not descend from) the head is recorded and no session runs. A session that does not finish records nothing |
| `selfReviewMaxFindings` | 5 | findings of one self-review filed as `bug` issues; the rest are dropped |
| `selfUpdate` | `false` | `hx run --watch` updates its own hx install when idle (a git checkout: fast-forward; a release: `hx update`) and restarts itself; rolled back when the new runner does not start (see [Stopping and resuming](#stopping-and-resuming)). `hx init` asks when hx runs from a git checkout |
| `selfUpdateMinutes` | 15 | minutes between the self-update checks of `hx run --watch` |
| `autoStart` | `false` | `hx run` keeps this repo's logon task (`hx service install`) in step: registers it when `true`, removes it when `false` (see [Starting at logon](#starting-at-logon)). `hx init` asks on Windows |
| `selfUpdateWatchMinutes` | 30 | minutes the new runner is watched after a self-update: a crash, failing sessions or a red first gate at its sha roll it back (see [Stopping and resuming](#stopping-and-resuming)) |
| `selfUpdateFailLimit` | 3 | sessions in a row ending with an agent or hx error that roll a watched self-update back |
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | keep it short: Windows path-length limits |
| `worktreeSetup` | `""` | a shell command run in every new worktree (sessions and the gate) before it is used, e.g. `npm ci`; `hx init` proposes one from the lockfile (see [Worktree setup](#worktree-setup)) |
| `worktreeSetupMinutes` | `10` | the setup command is killed, with its process tree, after this long and counts as failed |
| `worktreeCopy` | `[]` | untracked paths relative to the repo root (no `..`, globs or absolute paths) copied from the checkout into every new worktree and kept out of git; `hx init` adds a git-ignored `.env` |
| `claudeArgs` | `[]` | extra flags for every `claude` call |
| `leanWorkers` | `true` | workers start without MCP servers, skills, slash commands or user-level settings and plugins (~8K instead of ~44K tokens of base context per call) |
| `workerTools` | `Bash Read Edit Write Glob Grep` | the only built-in tools a lean worker gets; add e.g. `Agent` or `WebFetch` if your issues need them |
| `labels` | `ready-for-agent`, `agent-working`, `agent-blocked`, `prd`, `prd-hardened`, `prd-reviewed`, `security-reviewed`, `quality-bar-passed`, `security`, `hx-gate-fix`, `bug`, `bug-triaged`, `needs-human` (keys `ready`, `working`, `blocked`, `prd`, `hardened`, `reviewed`, `secured`, `barPassed`, `security`, `gateFix`, `bug`, `triaged`, `needsHuman`) | `hx init` creates them all; an issue with `needs-human` waits on the owner's answer: it is never claimed (even with `ready-for-agent`) and holds its PRD in building; `hx run` creates any missing at start, and a label edit that fails because a label is missing creates it and retries once |

## ⚠️ Safety

Workers run with `--permission-mode bypassPermissions`: the agent runs any command in its worktree
without asking, and pushes and merges to your default branch on its own. **Try it on a throwaway repo first.**

### Security: only trusted authors reach a worker

Anyone can open an issue or comment on a public repo, and an agent with bypassPermissions acts on what
it reads. So Hx only works on text from **trusted accounts**: your `gh` login plus `trustedAuthors`
(case-insensitive).

- Only issues and PRDs opened by a trusted account are claimed. Anything else is skipped (logged once
  per run) and shown as `untrusted` in `hx status` / `hx run --dry-run`; a child of an untrusted PRD is
  untrusted too.
- Agents read issues through `scripts/issue.mjs`, which prints the issue with comments from untrusted
  accounts removed — never `gh issue view --comments`. Every session gets the trusted set as `HX_TRUSTED`.
- Hx's own marker and handoff comments (`<!-- hx-handoff -->`, `<!-- hx-gauntlet -->`,
  `<!-- hx-security -->`, …) only count when a trusted account wrote them, so nobody else can fake a
  round, a handoff or a security verdict.
- `hx run` (and `hx status`) refuse to start if `gh api user` fails: without the login there is no
  trusted set.

## Files

- `.hx/usage.jsonl` — tokens for every turn (input / cache read / cache write / output)
- `.hx/logs/<role>-N.jsonl` — the raw Claude event stream per issue / PRD, for debugging
- `.hx/logs/setup-<name>.log` / `.json` — a worktree's last setup output / result (see [Worktree setup](#worktree-setup))
- `.hx/live.json` — the running `hx run`: its pid and live sessions (read by `hx status`)
- `.hx/pause` — present while paused (`drain` or `now`)
- `.hx/exit.json` — how the last `hx run --watch` ended: `{ pid, code, at }` (read by `hx supervise` for a runner a self-update started)
- `.hx/held.json` — audited PRs held while the default branch is red: `{ "<issue>": { pr, round, at } }`, cleared when the merge is retried
- `.hx/gate-runs.jsonl` — one line per pool gate run whose test command finished or timed out: `{ ts, sha, ok, durationMs, timedOut }`
  (`durationMs` is the test command only; the release gate is not recorded). `hx run` logs `gate is slow: …` once when the median of the last 5 is above 70% of `gateMinutes`
- `.hx/health.json` — the health pass: when it first saw each `agent-working` issue with no live session, and the last pass's time and line (see [Self-check](#self-check))
- `.hx/selfupdate.json` — the last self-update line, the shas (or tags) whose runner did not start (`bad`), the sha a rollback left the checkout at, the open watch window (`watch`), the last rollback (`rollback`) and the last good version (`good`); `.hx/selfupdate-ready` is the new runner's ready marker
- `.hx/selfreview.json` — the head of `origin/<default>` the last self-review reviewed, and when: `{ sha, at }`
- `.hx/run.log` — the `hx run` log, `<ISO time> [#n] message` per line (rotated to `run.log.1` past 2 MiB), read by `hx dashboard`
- `~/.hx/fleet/hold.json` — the shared usage hold of `hx fleet run` (`{ until, reason, repo }`); every runner copies it
- `~/.hx/fleet/github-hold.json` — the shared GitHub hold, same shape: written by a runner whose GitHub API budget is
  below `ghReservePct` or that is waiting out a rate limit; every runner claims nothing until its `until`
- `~/.hx/repos.json` — every repo `hx init` and `hx run` have seen (root, `owner/name`, last seen), written
  at each `hx init` and each `hx run` start, for the fleet dashboard; `hx fleet forget <path>` removes an entry
  (a file that cannot be parsed is left as it is)

`.hx/` is added to `.git/info/exclude` by `hx init`, so it never shows up in `git status`.

## Development

From a clone (Node ≥ 23.6; nothing to build, nothing to install):

```bash
git clone https://github.com/MorphEdit/Hx
cd Hx
npm link        # puts this checkout's hx on PATH (hx update --force replaces it with a release)
npm test
```

The end-to-end test uses real git (a local bare repo as origin) with fake `gh` and `claude`
(`test/fakes/`).

See [docs/design.md](design.md) for how Hx relates to Harness and the roadmap, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for how changes are made and released.
