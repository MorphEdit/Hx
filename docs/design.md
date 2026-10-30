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
| 4 | Token optimisation | |

## Token optimisation notes (phase 4)

Already in place: a fresh session per issue, a terse-prose instruction in the prompt.

Measured (see the [benchmark](../README.md#benchmark), `bench/results/`):
- Six small issues: a single session used **0.67M tokens in 12 API calls**; Hx used **~2.5M in 48 calls**
  (≈400K per issue, 8 calls each). Cache reads are ~95% of every run.
- Each Hx call carries a ~45–50K base context: system prompt + tools + the machine's plugins, skills
  and MCP servers. 8 calls × ~50K ≈ the whole per-issue cost — the work itself is a small fraction.
- The single session amortised the routine: it wrote a `ship.sh` for branch → PR → merge once and
  reused it. Each Hx session rediscovers the repo and the routine from scratch.
- A one-word reply in a worker already costs ~22K tokens; a `--resume` turn re-wrote the cache
  (24.7K cache write, 0 cache read) instead of reading it.

Levers, biggest first:
1. **Shrink the base context** of worker sessions: `--bare`, `--strict-mcp-config` with no servers,
   no plugins or user skills in worker worktrees. Workers need git, gh, a shell and file tools only.
2. **Fewer calls per issue**: ship the branch → test → PR → rebase → merge routine as one hx-provided
   script the agent calls once, instead of 5–6 separate tool calls.
3. **Shorter prompts**, re-sent with every session.
4. Model per role: a smaller model for decompose and review where it holds up.
5. A token budget per issue: over it, checkpoint + handoff and start a fresh session.
6. Find out why `--resume` misses the cache.

Each lever is checked by re-running the benchmark (`node bench/run.mjs hx3`).
