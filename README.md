# hx

A Windows-native pool of autonomous Claude Code workers for a GitHub-issues board.
Inspired by [VocanicZ/Harness](https://github.com/VocanicZ/Harness).

Every issue gets its own git worktree and a **fresh Claude session**, re-prompted until the agent
finishes (tests → PR → merge → issue closed). No tmux, no screen scraping: hx drives
`claude -p --output-format stream-json` directly, so it runs on plain Windows (and anywhere else Node runs).

## Requirements

- Node ≥ 23.6 (runs the TypeScript directly: no dependencies, no build step)
- `git`, `gh` (authenticated), `claude`

## Install

```bash
git clone https://github.com/MorphEdit/hx
cd hx
npm link
```

## Usage

```bash
cd <your repo>
hx init                 # writes .hx/config.json and creates the GitHub labels
hx status               # the board: claimable / working / waiting / blocked
hx run --dry-run        # what would be claimed, without changing anything
hx run                  # work through every claimable issue, then exit
hx run --watch          # keep running and pick up new or unblocked issues
hx run --issue 12,15    # only these issues
hx usage --by issue     # recorded token usage (by issue | model | day)
```

**An issue is picked up** when it is open, labelled `ready-for-agent`, not labelled `agent-working`
or `agent-blocked`, and every issue listed under its `Blocked by` heading is closed:

```markdown
## Blocked by
#12
other-owner/other-repo#3
```

Write `None` under the heading (or leave it out) for an issue with no dependencies.

Ctrl+C once stops every session, hands its issue back, and keeps the worktree so the next run
continues where it left off. Ctrl+C twice force-quits.

## What happens to an issue

| Outcome | hx does |
|---|---|
| agent prints `<promise>ISSUE n DONE</promise>` and the issue is closed | removes `agent-working` and the worktree |
| no promise after `maxIterations` turns, or the agent errors | comments the reason and last reply on the issue, labels it `agent-blocked`, keeps the worktree |
| usage limit hit | releases the issue, stops claiming until the limit resets |

Remove `agent-blocked` from an issue to let hx try it again.

## Config (`.hx/config.json`)

| key | default | |
|---|---|---|
| `workers` | 2 | sessions running in parallel |
| `model` | `sonnet` | model for every session |
| `maxIterations` | 8 | turns per issue before giving up |
| `turnTimeoutMinutes` | 45 | wall-clock limit for one turn |
| `pollSeconds` | 60 | how often the board is re-read |
| `worktreeRoot` | `<drive>:\hx-wt\<repo>` | keep it short: Windows path-length limits |
| `claudeArgs` | `[]` | extra flags for every `claude` call |
| `labels` | `ready-for-agent`, `agent-working`, `agent-blocked` | |

## ⚠️ Safety

Workers run with `--permission-mode bypassPermissions`: the agent runs any command in its worktree
without asking, and pushes and merges to your default branch on its own. **Try it on a throwaway repo first.**

## Files

- `.hx/usage.jsonl` — tokens for every turn (input / cache read / cache write / output)
- `.hx/logs/issue-N.jsonl` — the raw Claude event stream per issue, for debugging

`.hx/` is added to `.git/info/exclude` by `hx init`, so it never shows up in `git status`.

## Development

```bash
npm test
```

The end-to-end test uses real git (a local bare repo as origin) with fake `gh` and `claude`
(`test/fakes/`).

See [docs/design.md](docs/design.md) for how hx relates to Harness and the roadmap.

## Credits

The core ideas come from [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT): GitHub issues
as the only state, the `## Blocked by` grammar, one worktree per issue, a Ralph loop ending on a
`<promise>`, and role-specific prompts. hx's code is written from scratch.

## License

MIT
