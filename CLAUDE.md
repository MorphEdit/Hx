# Hx — notes for Claude sessions working on this repo

Hx is a Windows-native rewrite of the ideas in [VocanicZ/Harness](https://github.com/VocanicZ/Harness):
a pool of headless Claude Code workers (`claude -p --output-format stream-json`) driving a GitHub-issues
board. Read `README.md` (what it does, benchmark) and `docs/design.md` (why it is built this way, the
roadmap and the agreed order of the next features) before changing anything.

## Where things are
- `src/` — TypeScript run directly by Node ≥ 23.6 (type stripping): no build, no dependencies.
  Erasable syntax only (no enums, no parameter properties); imports end in `.ts`.
  `state.ts` pure board logic · `pool.ts` runner + sessions · `agent.ts` claude process + Ralph loop ·
  `runstate.ts` live.json / pause · `github.ts` gh wrapper · `worktree.ts` · `config.ts` · `cli.ts`
- `prompts/` — one per role (`impl`, `decompose`, `review`, `continue`, `checkpoint`), `{{VAR}}` placeholders
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
- Workers run with bypassPermissions. Anything that lets text from GitHub reach a prompt is a security
  question first.

## Next up
The roadmap in `docs/design.md` lists the remaining features in the order the user chose (highest
quality gain first): the auditor per issue (#1) is next, then the grill session (#2).
