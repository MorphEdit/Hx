# Hx — notes for Claude sessions working on this repo

Hx is a Windows-native rewrite of the ideas in [VocanicZ/Harness](https://github.com/VocanicZ/Harness):
a pool of headless Claude Code workers (`claude -p --output-format stream-json`) driving a GitHub-issues
board. Read `README.md` (what it does, benchmark) and `docs/design.md` (why it is built this way, the
roadmap and the agreed order of the next features) before changing anything.

## Where things are
- `src/` — TypeScript run directly by Node ≥ 23.6 (type stripping): no build, no dependencies.
  Erasable syntax only (no enums, no parameter properties); imports end in `.ts`.
  `state.ts` pure board logic · `pool.ts` runner + sessions · `agent.ts` agent process + Ralph loop ·
  `agents/` the agent-CLI seam (`AgentCli`, registry by `config.agentCli`; `claude.ts` argv + stream-json) ·
  `runstate.ts` live.json / pause · `github.ts` gh wrapper · `worktree.ts` · `config.ts` · `cli.ts`
  · `dashboard.ts` `hx dashboard` server (localhost, GET only) · `dashboard.html` its page (text only, no `innerHTML`) ·
  `outcomes.ts` run.log → outcome numbers ·
  `fleet.ts` `hx fleet`: ~/.hx/fleet.json, file slots (shared worker cap), hold.json (shared usage hold), the child runners
- `prompts/` — one per role (`impl`, `decompose`, `review`, `continue`, `checkpoint`, `grill`, `issue`, `audit`, `critic`, `revise`, `security`, `triage`), `{{VAR}}` placeholders; `skills` holds the note appended after a skill (`prompts/skills/<name>.md`, inserted verbatim, never rendered)
- `scripts/issue.mjs` — prints an issue with comments from untrusted accounts removed (`HX_TRUSTED`); the only way agents read issues
- `scripts/ship.mjs` — the one-call commit → rebase → test → push → PR → merge → close routine workers use
- `test/` — `npm test`. End-to-end tests use real git (local bare origin) with fake `gh` and `claude`
  in `test/fakes/` (`HX_GH_BIN`, `claudeBin` pointing at a `.mjs` run under node)
- `bench/` — the six-issue benchmark (`node bench/run.mjs chat|hx1|hx3`, then `node bench/figures.mjs`).
  It creates private GitHub repos and spends real usage: run it only when asked.

## Conventions
- Everything in the repo is English (code, docs, commits). Talk to the user in Thai.
- `npm test` must pass before every commit; never push with a failing test.
- A change that can affect quality or tokens is re-measured with the benchmark, and the README numbers
  and figures are regenerated from the new results — never edited by hand.
- Defaults: model `claude-opus-5-5` (full id; the `opus` alias resolved to an older Opus), effort `medium`.
- Windows: keep paths short (worktrees), spawn without a shell, pass prompts and bodies via stdin.
- Role prompts (all but `grill` and `issue`) tell workers to run every command in the foreground and wait for it: never start a command
  in the background, never poll for its output in a loop. A turn with no stdout for `stallMinutes` is killed.
- Workers run with bypassPermissions. Anything that lets text from GitHub reach a prompt is a security
  question first. Agents read issues only through `scripts/issue.mjs` (never `gh issue view --comments`);
  only issues opened by trusted accounts (the `gh` login + `trustedAuthors`) are claimed.

## Next up
The auditor (#1), the CI gate (#4), the grill session (#2, `hx grill`), the gauntlet (#3: a critic →
reviser loop before decompose, a security pass before a PRD closes), rtdd (#5, #34: skills per role via
`roleSkills`), the bug lane (#6, PRD #78: `hx bug`, triage sessions, bugs built first),
inject (#7, PRD #97: `hx issue`, filing wakes `hx run --watch`) and multi-repo / multi-CLI (#10, PRD #98:
`hx fleet` with a shared worker cap and usage hold, the `AgentCli` seam in `src/agents/`) are done.
Every item on the roadmap is built. New work starts as a PRD (`hx grill` or `hx issue`); run
`hx run --watch` on this repo and review the merged PRs. Re-run the benchmark and the audit eval
(`node bench/audit-eval.mjs`) after changes to prompts, roles or the merge path.
