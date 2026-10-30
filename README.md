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
the figures are drawn from [`bench/results/`](bench/results).

![Timeline: the same 6 issues, three ways](docs/figures/bench-timeline.svg)

![Benchmark summary](docs/figures/bench-summary.svg)

| | Single session | Hx · 1 worker | Hx · 3 workers |
|---|---|---|---|
| How | one Claude session does all 6 in a row | a fresh session per issue, one at a time | fresh sessions, in parallel where `Blocked by` allows |
| Wall time | **3.2 min** | 7.3 min | 3.6 min |
| Tokens | **0.67M** | 2.57M | 2.45M |
| Claude API calls | 12 | 48 | 48 |
| Issues closed · PRs merged | 6 · 6 | 6 · 6 | 6 · 6 |
| Hidden tests | 6/6 | 6/6 | 6/6 |

`claude-opus-5-5`, medium effort, 2026-10-30. No human input after the start in any run.

**What this shows, honestly:**

- **On six small issues, one session is cheaper and about as fast.** It wrote a `ship.sh` helper for the
  branch → PR → merge routine and finished everything in 12 API calls. Every Hx session starts cold
  and spends ~8 calls on one issue, and each call carries a ~45K-token base context (system prompt,
  tools, and the plugins and MCP servers installed on the machine). That fixed cost per session is
  what Hx's tokens are made of here — and what [phase 4](docs/design.md#roadmap) goes after.
- **Parallelism works:** 3 workers finish in half the time of 1 worker for the same tokens, by
  running `#1 #3 #6` together, then `#2 #4`, then `#5`.
- **Where Hx is meant to win is not measured here:** long projects. A single session carries its whole
  history into every call, so its cost per call grows with the project (hundreds of K tokens per
  message after a few hours), and it can be lost to a crash or a usage limit. Hx's cost per issue stays
  flat, issues survive a stop (checkpoint + handoff), and PRDs are decomposed and reviewed on their own.
  A larger benchmark is on the roadmap.

Reproduce (creates private repos on your GitHub account and spends real usage):

```bash
node bench/run.mjs chat
node bench/run.mjs hx1
node bench/run.mjs hx3
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
hx init                 # writes .hx/config.json and creates the GitHub labels
hx prd feature.md       # file a PRD issue (title from the file's first "# " line)
hx status               # the runner, live sessions, usage window, and the board
hx run --dry-run        # the board and what would run next, without changing anything
hx run                  # work the board until nothing is left, then exit
hx run --watch          # keep running and pick up new or unblocked work
hx run --issue 12,15    # only these issues / PRDs
hx pause [--now]        # from another terminal: stop a running hx run (see below)
hx resume               # clear a pause
hx usage --by role      # recorded token usage (by issue | role | model | day)
```

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
with `hx prd`. `hx run` then takes it all the way:

```
PRD #20 [prd] ──decompose──▶ child issues [ready-for-agent], each ending in
                              ## Blocked by  (#n / None)   and   ## Parent  #20
     │
     ├─ children are implemented in parallel, in dependency order (one session each)
     │
     ├─ all children closed ──review──▶ gaps found → gap issues filed → implemented → review again
     │                                  no gaps    → label prd-reviewed
     │
     └─ reviewed + all children closed ──▶ Hx closes the PRD
```

- A PRD's own `## Blocked by` sequences PRDs: nothing of PRD #21 runs until #20 is closed.
  PRDs without blockers run in parallel.
- Every review posts a `<!-- hx-review -->` comment on the PRD. After `reviewRounds` reviews
  without a sign-off, Hx labels the PRD `agent-blocked` for a human.
- Decompose and review sessions only file issues, labels and comments; they never push code.

## Single issues

**An issue is picked up** when it is open, labelled `ready-for-agent`, not labelled `agent-working`
or `agent-blocked`, and every issue listed under its `Blocked by` heading is closed:

```markdown
## Blocked by
#12
other-owner/other-repo#3
```

Write `None` under the heading (or leave it out) for an issue with no dependencies.

## What happens to an issue

| Outcome | Hx does |
|---|---|
| agent prints `<promise>ISSUE n DONE</promise>` and the issue is closed | removes `agent-working` and the worktree |
| no promise after `maxIterations` turns, or the agent errors | comments the reason and last reply on the issue, labels it `agent-blocked`, keeps the worktree |
| usage limit hit | releases the issue, stops claiming until the limit resets |
| Claude rejects the setup (API 400/401/403/404: unknown model, outdated CLI, auth) | hands the issue back untouched and stops the whole run with the reason |

Remove `agent-blocked` from an issue to let Hx try it again.

## Config (`.hx/config.json`)

| key | default | |
|---|---|---|
| `workers` | 2 | sessions running in parallel |
| `model` | `claude-opus-5-5` | model for every session; prefer a full id — the `opus` alias may resolve to an older Opus |
| `effort` | `medium` | `claude --effort`: `low`, `medium`, `high`, `xhigh`, `max`, or `""` for the CLI default |
| `maxIterations` | 8 | turns per session before giving up |
| `reviewRounds` | 3 | PRD reviews before a human has to look |
| `usagePauseAt` | 0.9 | claim nothing new once a usage window is this full (0..1) |
| `checkpointMinutes` | 10 | time a stopped session gets to commit, push and write its handoff |
| `turnTimeoutMinutes` | 45 | wall-clock limit for one turn |
| `pollSeconds` | 60 | how often the board is re-read |
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | keep it short: Windows path-length limits |
| `claudeArgs` | `[]` | extra flags for every `claude` call |
| `labels` | `ready-for-agent`, `agent-working`, `agent-blocked`, `prd`, `prd-reviewed` | |

## ⚠️ Safety

Workers run with `--permission-mode bypassPermissions`: the agent runs any command in its worktree
without asking, and pushes and merges to your default branch on its own. **Try it on a throwaway repo first.**

## Files

- `.hx/usage.jsonl` — tokens for every turn (input / cache read / cache write / output)
- `.hx/logs/<role>-N.jsonl` — the raw Claude event stream per issue / PRD, for debugging
- `.hx/live.json` — the running `hx run`: its pid and live sessions (read by `hx status`)
- `.hx/pause` — present while paused (`drain` or `now`)

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
