# Hx — notes for Claude sessions working on this repo

Hx is a Windows-native rewrite of the ideas in [VocanicZ/Harness](https://github.com/VocanicZ/Harness):
a pool of headless Claude Code workers (`claude -p --output-format stream-json`) driving a GitHub-issues
board. Read `README.md` (what it does), `docs/guide.md` (every command and setting) and `docs/design.md` (why it is built this way, the
roadmap and the agreed order of the next features) before changing anything.

## Where things are
- `src/` — TypeScript run directly by Node ≥ 23.6 (type stripping): no build, no dependencies.
  Erasable syntax only (no enums, no parameter properties); imports end in `.ts`.
  `state.ts` pure board logic · `pool.ts` runner + sessions · `agent.ts` agent process + Ralph loop ·
  `agents/` the agent-CLI seam (`AgentCli`, registry by `config.agentCli`; `claude.ts` argv + stream-json) ·
  `runstate.ts` live.json / pause · `github.ts` gh wrapper (rate-limited calls waited out during `hx run`) · `ghlimit.ts` the GitHub API budget: `rate_limit` parsing, the `github` line, limit kinds and waits (pure; the scripts import it too) · `worktree.ts` · `setup.ts` copy + setup command for each new worktree · `release.ts` `hx release` / autoRelease: version, notes, the gated tag and GitHub release · `config.ts` · `cli.ts`
  · `dashboard.ts` `hx dashboard` server (localhost, GET only) · `dashboard.html` its page (text only, no `innerHTML`) · `dashboard-fleet.html` the `hx dashboard --fleet` overview · `health.ts` the health pass: pure checks over one snapshot, their repairs, `.hx/health.json` · `selfreview.ts` the self-review session's state file (`.hx/selfreview.json`), when it is due, its findings parsed ·
  `question.ts` needs-human: the `<!-- hx-question -->` question on an issue and the trusted owner's answer (pure) ·
  `held.ts` a held merge: the failing-test names in a test output, held or not against a red gate, `.hx/held.json` ·
  `bar.ts` the quality bar's pure round helpers: `.hx/bar/<prd>/` paths, the A/B `.mapping`, the judge reply, the `<!-- hx-bar round=N -->` markers, the gap issue body ·
  `size.ts` the size session's pure helpers: its reply parsed (`SIZE: fits` / `split` / `narrow`, `=== CHILD k:` and `=== SCOPE` blocks), the `<!-- hx-size … -->` markers, the split trailers (`withTrailers`, `addBlockers`) ·
  `selfupdate.ts` the self-update of `hx run --watch`: `.hx/selfupdate.json`, the code-path filter, the git / release check, the restart with its ready marker and rollback, the watch window after it (#316) ·
  `outcomes.ts` run.log → outcome numbers · `timing.ts` test time: the test-command matcher, per-turn test time from stream-json events, the stats over usage.jsonl and gate-runs.jsonl · `doctor.ts` `hx doctor`: the prerequisite checks and their ✓ ✗ – ? marks (hx start's first step, hx run's startup gate) ·
  `supervise.ts` `hx supervise`: restarts a crashed `hx run --watch`, `.hx/supervise.json` · `service.ts` `hx service`: the logon task (schtasks XML) or the launchd / systemd unit ·
  `fleet.ts` `hx fleet`: ~/.hx/fleet.json, file slots (shared worker cap), hold.json (shared usage hold), the child runners
- `prompts/` — one per role (`impl`, `decompose`, `review`, `continue`, `checkpoint`, `grill`, `issue`, `audit`, `critic`, `revise`, `security`, `triage`, `size`, `selfreview`, `bar`, `bar-judge`), `{{VAR}}` placeholders; `skills` holds the note appended after a skill (`prompts/skills/<name>.md`, inserted verbatim, never rendered)
- `bin/` — `hx.mjs` the entry (Node check first, then `install` / `update` or the type-strip hook and `src/cli.ts`) ·
  `install.mjs` the `npx github:MorphEdit/Hx install` / `hx update` installer (ends with the checks of `src/doctor.ts`) · `node-check.mjs` · `strip-hook.mjs`
  the `module.registerHooks` load hook that strips hx's `.ts` under `node_modules`
- `templates/` — `hx-skill.md`, the `/hx` Claude Code skill `hx install-skill` writes to `~/.claude/skills/hx/SKILL.md`
- `scripts/issue.mjs` — prints an issue with comments from untrusted accounts removed (`HX_TRUSTED`); the only way agents read issues
- `scripts/ghwait.mjs` — the gh caller both scripts share: short rate limits waited out, capped by `HX_GH_WAIT_MAX_SECONDS`
- `scripts/ship.mjs` — the one-call commit → rebase → test → push → PR → merge → close routine workers use
- `scripts/test.mjs` — `npm test`: node --test over the suite, or only the files given (`npm test -- <files>`), at most `HX_TEST_CONCURRENCY` files at once
- `test/` — `npm test`. End-to-end tests use real git (local bare origin) with fake `gh` and `claude`
  in `test/fakes/` (`HX_GH_BIN`, `claudeBin` pointing at a `.mjs` run under node; `test/isolate.ts` sets `HX_GH_INPROC`, so the fake gh answers in-process)
- `bench/` — the six-issue benchmark (`node bench/run.mjs chat|hx1|hx3`, then `node bench/figures.mjs`), and the project benchmark (`node bench/project.mjs chat|hx3`: one brief
  through the whole PRD flow, graded by hidden tests; `figures.mjs` renders its table in `docs/benchmark.md` from
  `bench/results/project-*.json` via `bench/project-table.mjs`).
  It creates private GitHub repos and spends real usage: run it only when asked.

## Conventions
- Everything in the repo is English (code, docs, commits). Talk to the user in Thai.
- `npm test` must pass before every commit; never push with a failing test.
- User docs: `README.md` is a short landing page (what Hx is, how it works, quick start, everyday
  commands, links), kept under ~150 lines. Every detail (a command's flags, a setting, a section about a
  feature, a config row) goes in `docs/guide.md`; benchmark results go in `docs/benchmark.md`. Add to the
  README only what a first-time reader needs. Tests that check a feature is documented read all three
  (`test/docs-text.ts`).
- A change that can affect quality or tokens is re-measured with the benchmark, and the benchmark numbers
  and figures are regenerated from the new results — never edited by hand.
- Defaults: model `claude-opus-5-5` (full id; the `opus` alias resolved to an older Opus), effort `medium`.
- Windows: keep paths short (worktrees), spawn without a shell, pass prompts and bodies via stdin.
- Role prompts (all but `grill` and `issue`) tell workers to run every command in the foreground and wait for it: never start a command
  in the background, never poll for its output in a loop. A turn with no stdout for `stallMinutes` is killed.
- Workers run with bypassPermissions. Anything that lets text from GitHub reach a prompt is a security
  question first. Agents read issues only through `scripts/issue.mjs` (never `gh issue view --comments`);
  only issues opened by trusted accounts (the `gh` login + `trustedAuthors`) are claimed.

## Testing
- No test asserts a tight wall-clock upper bound: the gate runs `npm test` beside busy workers, and a missed
  timing bound turns `main` red for nothing (#285). In order of preference: (1) assert the order of events, not
  the time between them (a fake that records calls, a promise that resolves only if the code waits on it);
  (2) inject the clock or the delay and check the computed value; (3) where a real-time bound is the point, make
  it at least 10× the expected time and far below what must not be waited for (`< 20_000` against a 60 s sleeper).
  Lower bounds (`>= N`) are fine when both ends are measured at the right event.

## Next up
The auditor (#1), the CI gate (#4), the grill session (#2, `hx grill`), the gauntlet (#3: a critic →
reviser loop before decompose, a security pass before a PRD closes), rtdd (#5, #34: skills per role via
`roleSkills`), the bug lane (#6, PRD #78: `hx bug`, triage sessions, bugs built first),
inject (#7, PRD #97: `hx issue`, filing wakes `hx run --watch`) and multi-repo / multi-CLI (#10, PRD #98:
`hx fleet` with a shared worker cap and usage hold, the `AgentCli` seam in `src/agents/`) and the
quality bar (PRD #254: a blind A/B against a named product after review, `barRounds`, `quality-bar-passed`) are done.
Every item on the roadmap is built. New work starts as a PRD (`hx grill` or `hx issue`); run
`hx run --watch` on this repo and review the merged PRs. Re-run the benchmark and the audit eval
(`node bench/audit-eval.mjs`) after changes to prompts, roles or the merge path.
