<p align="center">
  <img src="docs/logo.svg" alt="Hx logo" width="128" height="128">
</p>

<h1 align="center">Hx</h1>

<p align="center"><em>Issues in, merged PRs out. Headless Claude Code workers on a GitHub board, native on Windows.</em></p>

<p align="center">
  <a href="https://github.com/MorphEdit/Hx/releases"><img alt="Release" src="https://img.shields.io/github/v/release/MorphEdit/Hx"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 23.6+" src="https://img.shields.io/badge/node-%3E%3D23.6-339933">
</p>

A Windows-native pool of autonomous Claude Code workers for a GitHub-issues board.
Inspired by [VocanicZ/Harness](https://github.com/VocanicZ/Harness).

Every issue gets its own git worktree and a **fresh Claude session**, re-prompted until the agent
finishes (tests → PR → merge → issue closed). No tmux, no screen scraping: Hx drives
`claude -p --output-format stream-json` directly, so it runs on plain Windows (and anywhere else Node runs).

## Benchmark

The same six issues (a small text-utilities library and its CLI, with a `Blocked by` graph:
`#2` and `#4` need `#1`, `#5` needs `#2 #3 #4`, `#6` is independent), each on a fresh GitHub repo,
three ways. Every run is graded by **hidden tests the agents never saw**. Real runs, not a mock-up:
the figures are drawn (and animated) from the logs in [`bench/results/`](bench/results).

![Hx: one board, three workers](docs/figures/hx-flow.svg)

![Timeline: the same 6 issues, three ways](docs/figures/bench-timeline.svg)

![Benchmark summary](docs/figures/bench-summary.svg)

| | Single session | Hx · 1 worker | Hx · 3 workers | Hx · 3 workers + auditor (default) |
|---|---|---|---|---|
| How | one Claude session does all 6 in a row | a fresh session per issue, one at a time | fresh sessions, in parallel where `Blocked by` allows | the same, and every PR is audited by a second session before hx merges it |
| Wall time | **3.2 min** | 6.0 min | 3.6 min | 5.5 min |
| Tokens | 0.67M | **0.40M** | **0.40M** | 0.69M |
| Sessions | 1 | 6 | 6 | 12 |
| Issues closed · PRs merged | 6 · 6 | 6 · 6 | 6 · 6 | 6 · 6 |
| Hidden tests | 6/6 | 6/6 | 6/6 | 6/6 |
| Independent check before merge | no | no | no | **yes** |

`claude-opus-5-5`, medium effort, 2026-10-30. No human input after the start in any run.

**What this shows:**

- **Phase 4 cut Hx's tokens by 84%** (2.45M → 0.40M for the same six issues, same hidden-test score).
  Every Hx session used to pay a ~44K-token base context on every call — the system prompt plus 44
  tools, 32 MCP servers and 78 skills installed on the machine, none of which a worker needs. Lean
  workers start at ~8K, and one `ship` script replaces the 5–6 calls the commit → rebase → test →
  PR → merge routine took.
- **The auditor costs about 0.05M tokens and 30 s per issue**, and is now on by default. These six
  issues were all done right first time, so here it only adds cost; what it is for is measured below.
- **Parallelism works:** 3 workers finish in 60% of the time of 1 worker for the same tokens.
- **The single session is still faster on six tiny issues** (one warm session never re-reads the repo)
  but has no second pair of eyes, and its cost per call grows with the project.

### Does the auditor catch real mistakes?

[`bench/audit-eval.mjs`](bench/audit-eval.mjs): for each of the six issues, one correct PR and one with
a **planted defect** that breaks a rule or an example stated in the issue while the PR's own tests still
pass (the way a careless implementer's tests would). Twelve independent audits, in random order, not
told which is which ([results](bench/results/audit-eval.json)):

| | |
|---|---|
| Planted defects caught | **6 / 6** — each with the exact rule, the wrong output, and how it was seen |
| Correct PRs passed | 5 / 6 |
| Cost | ~45K tokens and ~30 s per audit |

The one correct PR sent back (#1) was sent back for a real reason: the issue says "Add tests for these"
about six examples and the PR tested three. The auditor said the code itself was correct and named the
missing tests; in a real run that costs one more implement round.

### Do the gauntlet critic and the security pass catch real problems?

Same method, on smaller sets: each case gets one independent session, run in random order and not
told which cases are planted. Everything runs locally against a fake `gh`.

[`bench/critic-eval.mjs`](bench/critic-eval.mjs) gives the critic PRDs for the benchmark project. Three have a
planted defect: an undefined "short word", rules that say round down while the example rounds up, and an
error case with no exit code. One PRD is clean. [Results](bench/results/critic-eval.json).

[`bench/security-eval.mjs`](bench/security-eval.mjs) gives the security pass a merged PRD with one planted
vulnerability: an issue title in an `execSync` shell command, an issue title used as a path that is later
`rmSync`'d, or `GH_TOKEN` written to a debug log. A clean PRD is in the set too.
[Results](bench/results/security-eval.json).

| | Critic | Security pass |
|---|---|---|
| Planted problems caught | **3 / 3**, each finding naming the exact gap | **3 / 3**, one issue each, with file:line and an exploit scenario |
| Clean cases passed | 1 / 1 | 1 / 1 |
| Cost | ~29K tokens and ~17 s per critic | ~66K tokens and ~40 s per pass |

In the real run that built the gauntlet, the security pass also found a prompt injection in the
gauntlet's own critic and reviser prompts (MorphEdit/Hx#26). Hx fixed it before the PRD closed.

Before the auditor (same issues, same model): Hx · 3 workers 3.6 min / 0.40M tokens
([`bench/results/phase4/`](bench/results/phase4)); before phase 4: 3.6 min / 2.45M
([`bench/results/phase3/`](bench/results/phase3)).

Reproduce (creates private repos on your GitHub account and spends real usage):

```bash
node bench/run.mjs chat
node bench/run.mjs hx1
node bench/run.mjs hx3
node bench/audit-eval.mjs
node bench/critic-eval.mjs
node bench/security-eval.mjs
node bench/figures.mjs
```

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
hx init                 # writes .hx/config.json and creates the GitHub labels; --rtdd also runs
                        # rtdd init in the repo root (commit .rtdd/), without it a hint if rtdd is installed;
                        # an unset worktreeSetup comes from the first lockfile (pnpm-lock.yaml → pnpm install
                        # --frozen-lockfile, package-lock.json → npm ci, …), an unset worktreeCopy is [".env"]
                        # when .env is git-ignored
hx bug "status hangs"   # file a bug issue (label bug, text or a .md file; --title T); hx run triages it
hx prd feature.md       # file a PRD issue (title from the file's first "# " line)
hx grill "dark mode"    # an interactive claude session interviews you into a PRD (idea: text or a .md file),
                        # shows it and files it on confirm (--yes: no question); kept in .hx/prds/
hx issue "fix typo"     # a shorter session grills one small task into one issue, filed ready-for-agent on
                        # confirm (--bug: label bug, triaged first; --yes; --title T); kept in .hx/issues/
hx issue --file x.md    # file an issue file the same way, without a session (--bug, --title T)
hx status               # the runner, live sessions, usage window, and the board (issues opened by an
                        # untrusted account show as `untrusted` and are never claimed)
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
conflict, out of audit rounds, other) and "tests fail after the rebase" retries; also the hours of runs.
Only hx's own markers count (`<!-- hx-audit -->`, `**hx:** impl stopped`, `<!-- hx-retry -->`, the gate-fix
label), from a trusted account; each line shows the change (`+12%`, `-3`), and a period with fewer than 10
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

- **Now** — the runner ("not running", or its pid, uptime, workers, paused/draining and the rate-limit
  window), the live sessions (issue, kind, title, turn, tokens, elapsed) and the CI gate (green/red,
  sha, when, the fix issue).
- **Board** — PRDs with their status and `closed/total done`, and the open issues with their status.
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
| `hx resume`, then `hx run` | picks the issues up again: the worktree and branch still hold the work, and the new session's prompt includes the handoff note |
| Ctrl+C twice | force-quits and kills every session; the worktrees keep whatever was written |

While paused, `hx run` refuses to start until `hx resume`. Only one `hx run` per repo can run at a time.

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

## PRD flow

Write what you want as a PRD (a markdown file: goal, requirements, acceptance criteria) and file it
with `hx prd`. `hx run` then takes it all the way — `gauntlet → decompose → building → review → security → done`:

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
     └─ security-reviewed + all children closed ──▶ Hx closes the PRD
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

## Every PR is audited before it merges

The implementer never merges its own work. It ships with `ship.mjs --no-merge` and stops at an open PR.
Then a **separate auditor session**, in its own fresh checkout of the pushed branch, checks the PR
against the issue — every rule and example, by reading the code and running the cases itself, and
whether the new tests would fail if the feature were wrong. It answers `VERDICT: PASS` or `FAIL`
with findings, posted on the issue.

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

## What happens to an issue

| Outcome | Hx does |
|---|---|
| the audit passes and the merge goes through | hx merges the PR, closes the issue, removes `agent-working` and the worktree |
| the audit fails | the findings go to a fresh implementer session on the same branch; after `auditRounds` FAILs: `agent-blocked` |
| no promise after `maxIterations` turns, or the agent errors | comments the reason and last reply on the issue, labels it `agent-blocked`, keeps the worktree |
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

- Roles: `impl`, `audit`, `triage`, `decompose`, `critic`, `revise`, `review`, `security`. A field left out
  falls back to the top-level one; `effort` must be one of `low`, `medium`, `high`, `xhigh`, `max`.
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
| `roleModels` | `{}` | role (`impl`, `audit`, `triage`, `decompose`, `critic`, `revise`, `review`, `security`) → `{ "model", "effort" }` for its sessions; a field left out uses `model` / `effort` (see [Models per role](#models-per-role)) |
| `skillMaxChars` | `12000` | a skill whose `SKILL.md` body (front matter and HTML comments stripped) is longer is skipped |
| `rtddBin` | `"rtdd"` | the `rtdd` command (`HX_RTDD_BIN` overrides it) |
| `workers` | 2 | sessions running in parallel |
| `model` | `claude-opus-5-5` | model for every session; prefer a full id — the `opus` alias may resolve to an older Opus |
| `effort` | `medium` | `claude --effort`: `low`, `medium`, `high`, `xhigh`, `max`, or `""` for the CLI default |
| `agentCli` | `"claude"` | the agent CLI that workers, `hx grill` and `hx issue` run (an adapter in `src/agents/`); `claude` is the only one |
| `maxIterations` | 8 | turns per session before giving up |
| `gauntlet` | `true` | critique and revise a PRD in rounds before it is decomposed |
| `gauntletRounds` | 2 | critic → reviser rounds before the PRD is decomposed anyway |
| `reviewRounds` | 3 | PRD reviews before a human has to look |
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
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | keep it short: Windows path-length limits |
| `worktreeSetup` | `""` | a shell command run in every new worktree (sessions and the gate) before it is used, e.g. `npm ci`; `hx init` proposes one from the lockfile (see [Worktree setup](#worktree-setup)) |
| `worktreeSetupMinutes` | `10` | the setup command is killed, with its process tree, after this long and counts as failed |
| `worktreeCopy` | `[]` | untracked paths relative to the repo root (no `..`, globs or absolute paths) copied from the checkout into every new worktree and kept out of git; `hx init` adds a git-ignored `.env` |
| `claudeArgs` | `[]` | extra flags for every `claude` call |
| `leanWorkers` | `true` | workers start without MCP servers, skills, slash commands or user-level settings and plugins (~8K instead of ~44K tokens of base context per call) |
| `workerTools` | `Bash Read Edit Write Glob Grep` | the only built-in tools a lean worker gets; add e.g. `Agent` or `WebFetch` if your issues need them |
| `labels` | `ready-for-agent`, `agent-working`, `agent-blocked`, `prd`, `prd-hardened`, `prd-reviewed`, `security-reviewed`, `security`, `hx-gate-fix`, `bug`, `bug-triaged` (keys `ready`, `working`, `blocked`, `prd`, `hardened`, `reviewed`, `secured`, `security`, `gateFix`, `bug`, `triaged`) | `hx init` creates them all; `hx run` creates any missing at start, and a label edit that fails because a label is missing creates it and retries once |

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
- `.hx/gate-runs.jsonl` — one line per pool gate run whose test command finished or timed out: `{ ts, sha, ok, durationMs, timedOut }`
  (`durationMs` is the test command only; the release gate is not recorded). `hx run` logs `gate is slow: …` once when the median of the last 5 is above 70% of `gateMinutes`
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

See [docs/design.md](docs/design.md) for how Hx relates to Harness and the roadmap, and
[CONTRIBUTING.md](CONTRIBUTING.md) for how changes are made and released.

## Credits

The core ideas come from [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT): GitHub issues
as the only state, the `## Blocked by` grammar, one worktree per issue, a Ralph loop ending on a
`<promise>`, and role-specific prompts. Hx's code is written from scratch.

## License

MIT
