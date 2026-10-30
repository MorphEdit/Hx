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

Already in place: a fresh session per issue (the biggest saving), a terse-prose instruction in the prompt.

Measured so far:
- A one-word reply already costs ~22K tokens of context (system prompt, tools, plugins).
- A `--resume` turn re-wrote the whole cache (24.7K cache write, 0 cache read) instead of reading it.

Ideas:
- Model per role: Haiku/Sonnet for decompose and review, Opus only where needed.
- A token budget per issue: over it, write a handoff note and start a fresh session.
- Shrink the base context: `--bare`, or disable plugins / MCP servers in worker worktrees.
- Keep prompts short; they are re-sent with every session.
- Find out why `--resume` misses the cache.
