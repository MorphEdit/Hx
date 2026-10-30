# Hx

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
git clone https://github.com/MorphEdit/Hx
cd Hx
npm link
```

## Usage

```bash
cd <your repo>
hx init                 # writes .hx/config.json and creates the GitHub labels; --rtdd also runs
                        # rtdd init in the repo root (commit .rtdd/), without it a hint if rtdd is installed
hx prd feature.md       # file a PRD issue (title from the file's first "# " line)
hx grill "dark mode"    # an interactive claude session interviews you into a PRD (idea: text or a .md file),
                        # shows it and files it on confirm (--yes: no question); kept in .hx/prds/
hx status               # the runner, live sessions, usage window, and the board (issues opened by an
                        # untrusted account show as `untrusted` and are never claimed)
hx run --dry-run        # the board and what would run next, without changing anything
hx run                  # work the board until nothing is left, then exit
hx run --watch          # keep running and pick up new or unblocked work
hx run --issue 12,15    # only these issues / PRDs
hx pause [--now]        # from another terminal: stop a running hx run (see below)
hx resume               # clear a pause
hx usage --by role      # recorded token usage (by issue | role | model | day)
hx dashboard [--open]   # a read-only page on http://127.0.0.1:4777/ (localhost only; --port N)
```

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
- **Stats** — tokens per day, tokens/turns/sessions/time by PRD, role and model, and outcomes parsed
  from the run log: audit PASS/FAIL and average rounds, gauntlet rounds and FAILs, security passes and
  how many of them filed issues, gate REDs with the average RED → green time, and the median issue wall time.
- **Log** — the tail of `.hx/run.log`, newest last.

`hx run` writes every line it prints to `.hx/run.log` with an ISO timestamp; past 2 MiB the file is
rotated to `run.log.1` (one old file is kept), and the outcome numbers are parsed from `run.log` only.

Safety: the server binds **127.0.0.1 only**, answers only a `Host` of `127.0.0.1:<port>` or
`localhost:<port>` (no DNS rebinding), takes **GET only**, sends no CORS headers and changes nothing —
it only reads. The page is one self-contained file under a strict CSP (no external scripts, styles or
fonts), and every title, label, error and log line is rendered as **escaped text** (`textContent`,
never `innerHTML`), so an issue titled `<img src=x onerror=…>` shows as that text.

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

**Usage limits:** Hx reads Claude's usage-window events. Once a window is `usagePauseAt` full (90% by
default), it claims nothing new until the window resets; running sessions carry on. If a session hits
the limit anyway, its issue is handed back and picked up again after the reset.

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

A hung test run cannot block anything: `ship.mjs` gives the tests `--test-timeout` minutes (default 15,
remembered for `--resume`) and the gate 20 minutes; past that the whole process tree is killed and the
run counts as failed (exit 4 / a red gate marked "timed out").

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

## Config (`.hx/config.json`)

| key | default | |
|---|---|---|
| `trustedAuthors` | `[]` | accounts besides the gh login whose issues and PRDs hx works on (case-insensitive); anything opened by anyone else is skipped and shown as `untrusted` |
| `roleSkills` | `{"impl":["rtdd"],"audit":["rtdd"]}` | role → skills (`SKILL.md` from `<repo>/.claude/skills`, `~/.claude/skills`, `<repo>/.agents/skills`) appended to its prompt, resolved once per `hx run` (logged, and in `live.json`); `{}` = none. rtdd is used only when `.rtdd/config.yaml` is on `origin/<defaultBranch>` and `rtddBin --version` works; its sessions get `prompts/skills/rtdd.md` too, and a path `rtddBin` its directory first on `PATH` |
| `skillMaxChars` | `12000` | a skill whose `SKILL.md` body (front matter and HTML comments stripped) is longer is skipped |
| `rtddBin` | `"rtdd"` | the `rtdd` command (`HX_RTDD_BIN` overrides it) |
| `workers` | 2 | sessions running in parallel |
| `model` | `claude-opus-5-5` | model for every session; prefer a full id — the `opus` alias may resolve to an older Opus |
| `effort` | `medium` | `claude --effort`: `low`, `medium`, `high`, `xhigh`, `max`, or `""` for the CLI default |
| `maxIterations` | 8 | turns per session before giving up |
| `gauntlet` | `true` | critique and revise a PRD in rounds before it is decomposed |
| `gauntletRounds` | 2 | critic → reviser rounds before the PRD is decomposed anyway |
| `reviewRounds` | 3 | PRD reviews before a human has to look |
| `security` | `true` | a security pass checks a reviewed PRD's merged work before the PRD closes |
| `securityRounds` | 2 | security passes that file issues before a human has to look |
| `audit` | `true` | an independent auditor checks every implementation PR before hx merges it |
| `auditRounds` | 3 | implement → audit attempts before the issue goes to a human |
| `gate` | `true` | test the default branch after every merge; while red, claim only its fix |
| `gateCommand` | `""` | the gate's test command (empty: learned from the first audited merge) |
| `usagePauseAt` | 0.9 | claim nothing new once a usage window is this full (0..1) |
| `checkpointMinutes` | 10 | time a stopped session gets to commit, push and write its handoff |
| `turnTimeoutMinutes` | 45 | wall-clock limit for one turn |
| `pollSeconds` | 60 | how often the board is re-read |
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | keep it short: Windows path-length limits |
| `claudeArgs` | `[]` | extra flags for every `claude` call |
| `leanWorkers` | `true` | workers start without MCP servers, skills, slash commands or user-level settings and plugins (~8K instead of ~44K tokens of base context per call) |
| `workerTools` | `Bash Read Edit Write Glob Grep` | the only built-in tools a lean worker gets; add e.g. `Agent` or `WebFetch` if your issues need them |
| `labels` | `ready-for-agent`, `agent-working`, `agent-blocked`, `prd`, `prd-hardened`, `prd-reviewed`, `security-reviewed`, `security` | |

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
- `.hx/live.json` — the running `hx run`: its pid and live sessions (read by `hx status`)
- `.hx/pause` — present while paused (`drain` or `now`)
- `.hx/run.log` — the `hx run` log, `<ISO time> [#n] message` per line (rotated to `run.log.1` past 2 MiB), read by `hx dashboard`

`.hx/` is added to `.git/info/exclude` by `hx init`, so it never shows up in `git status`.

## Development

```bash
npm test
```

The end-to-end test uses real git (a local bare repo as origin) with fake `gh` and `claude`
(`test/fakes/`).

See [docs/design.md](docs/design.md) for how Hx relates to Harness and the roadmap.

## Credits

The core ideas come from [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT): GitHub issues
as the only state, the `## Blocked by` grammar, one worktree per issue, a Ralph loop ending on a
`<promise>`, and role-specific prompts. Hx's code is written from scratch.

## License

MIT
