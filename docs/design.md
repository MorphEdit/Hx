# Design

## How Harness works

[Harness](https://github.com/VocanicZ/Harness) runs a fleet of agent sessions against a GitHub-issues board:

```
PRD issue ──DECOMPOSE──▶ child issues [ready-for-agent], each with "## Blocked by" / "## Parent"
    │
worker pool (N) polls the board
  ├─ claims an issue whose blockers are closed (label agent-working)
  ├─ git worktree per issue (branch issue/<n>)
  ├─ renders a role prompt, starts a fresh Claude Code session in tmux
  ├─ Ralph loop: a Stop hook re-feeds the task until the reply contains <promise>…</promise>
  └─ the agent tests, opens a PR, rebases, gates, merges, closes the issue
    │
all children closed ──REVIEW──▶ files gap issues, or signs off ──▶ engine closes the PRD
```

All state lives in GitHub (issues, labels, branches, PRs), so a fleet can stop and resume from any host.

## Why it does not run on Windows

| Linux-only piece | used for |
|---|---|
| tmux (21 files) | runs the interactive TUI and **reads the screen** (`capture-pane`) to tell idle / busy / rate-limited; types with `send-keys` |
| `flock` | claim locks between worker processes |
| `/proc/<pid>/environ` | mapping processes to fleets |
| systemd | the supervisor and dashboard units |
| bash, symlinks | the engine itself |

Most of the engine's complexity (pane regexes, stall detection, trust dialogs, nudging frozen
sessions) exists because it drives a TUI through tmux.

## What Hx does instead

Claude Code has a headless mode that gives the same capability without a terminal:

```
claude -p --output-format stream-json --verbose --session-id <uuid> ...   (first turn, prompt on stdin)
claude -p --output-format stream-json --verbose --resume <uuid> ...       (each further turn)
```

- The turn ends when the process exits; the `result` event says whether it succeeded.
- The Ralph loop is a plain loop in `src/agent.ts`: look for the promise, otherwise `--resume`.
- Exact token usage (input, cache read, cache write, output) arrives with every turn.
- A usage limit shows up as a `rate_limit_event` with `status: rejected`, with its reset time.

| Harness | Hx |
|---|---|
| tmux session per worker | `child_process.spawn`, one Node process |
| `flock` + claim files | in-memory claims in one process, plus the `agent-working` label |
| pane-scraping watchdog | per-turn timeout + the JSON result |
| 7 CLI adapters | Claude Code only |
| bash + python | TypeScript run directly by Node ≥ 23.6 |

Kept as-is: GitHub as the only state, the `## Blocked by` grammar, a worktree per issue,
role prompts, promise-based completion.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | `hx run`: claim ready issues, worktree, Ralph loop, PR → merge → close, worker pool, token log | done |
| 2 | PRD flow: decompose a PRD into issues, review (gap issues or sign-off), close the PRD, PRD sequencing | done |
| 3 | Robustness: pause / pause --now with checkpoint + handoff, crash recovery, one runner per repo, proactive usage-window holds, live `hx status` | done |
| 4 | Token optimisation: lean workers, one-call `ship` script, shorter prompts — **−84% tokens** on the benchmark | done |

### Next: the rest of Harness's features, ordered by how much they improve the quality of what Hx ships

Agreed order (2026-10-30). The author filter goes first anyway: it is small, and it is a safety fix —
the repo is public and workers run with bypassPermissions, so an outsider's issue must never become a prompt.

| # | Feature | What it adds | Notes |
|---|---|---|---|
| 0 | **Author filter** | only issues (and PRDs) opened by allowed authors (default: the repo owner / `gh` login) are claimed | Harness: `HARNESS_AUTHOR_ALLOWLIST`, filtered before PRD selection and claiming |
| 1 | **Auditor per issue** | a fresh session checks the implementer's work against the issue before merge; a failed audit goes back to the implementer | biggest quality gain; measure with the benchmark (hidden tests, tokens) |
| 2 | **Grill session** | `hx grill` interviews the user until the PRD is unambiguous, then files it | interactive `claude`, not headless |
| 3 | **Gauntlet / security audit** | PRD review in rounds with a critic, plus a security pass; gaps become issues | builds on the auditor |
| 4 | **CI gate** | no new claims while the default branch is red; running sessions continue | Harness: `ci_gate_ok` |
| 5 | **rtdd** | names the tests a change needs and the changed lines no test reaches | check `npx github:VocanicZ/rtdd` on Windows first |
| 6 | **Bug lane** | `bug` issues: a triage session, then a fix session; priority over normal issues | reuses auditor + CI gate |
| 7 | **Inject into a running fleet** | `hx prd/issue` while `hx run --watch` runs (grill → file) | mostly done: `--watch` already picks new issues up |
| 8 | **Web dashboard / stats** | read-only local page over `live.json`, `usage.jsonl`, the board; stats per PRD/role/model | |
| 9 | **Multi-repo / multi-CLI** | one fleet over several repos; other agent CLIs | only when there is a real need |

Every phase ships with tests; anything that can change quality or tokens is re-measured with
`node bench/run.mjs hx3` (and `hx1`/`chat` when comparing).

## Token optimisation (phase 4)

Measured before (see the [benchmark](../README.md#benchmark), `bench/results/phase3/`):
- Six small issues: a single session used 0.67M tokens in 12 API calls; Hx used ~2.5M in 48 calls
  (≈410K per issue, 8 calls each). Cache reads are ~95% of every run.
- Every Hx call carried a ~44K base context. Measured with a one-line prompt:

  | worker flags | base context | tools · MCP · skills |
  |---|---|---|
  | default | 44.4K | 44 · 32 · 78 |
  | `--strict-mcp-config` | 41.8K | 30 · 0 · 78 |
  | + `--disable-slash-commands` | 34.8K | 29 · 0 · 0 |
  | + `--setting-sources project,local` | 34.3K | 29 · 0 · 0 |
  | + `--tools Bash Read Edit Write Glob Grep` | **8.2K** | 6 · 0 · 0 |

  (`--bare` would be smaller still, but it ignores the OAuth login: API keys only.)
- The single session amortised the routine: it wrote a `ship.sh` for branch → PR → merge once and
  reused it. Each Hx session re-did that routine by hand.

Done:
1. **Lean workers** (`leanWorkers`, `workerTools`): the flags in the last row above.
2. **`scripts/ship.mjs`**: commit → rebase → test → push → PR → squash-merge → delete branch → close,
   one call, with distinct exit codes for a rebase conflict and for failing tests.
3. **Shorter implementation prompt** that tells the agent to batch commands and read only what it needs.

Result, same six issues and model: Hx · 3 workers **2.45M → 0.40M tokens**, 48 → 36 API calls,
3.6 min both, hidden tests 6/6 both. Hx · 1 worker 2.57M → 0.40M, 7.3 → 6.0 min.

Still open:
- Model per role: a smaller model for decompose and review where it holds up.
- A token budget per issue: over it, checkpoint + handoff and start a fresh session.
- `--resume` turns re-write the cache (24.7K cache write, 0 cache read) instead of reading it.
- A long-project benchmark (dozens of issues, a PRD), where a single session's growing context should
  cost it far more than here.
