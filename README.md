<p align="center">
  <img src="docs/logo.svg" alt="Hx logo" width="128" height="128">
</p>

<h1 align="center">Hx</h1>

<p align="center"><em>Describe what you want. A pool of Claude Code workers builds it, checks it, and merges it.</em></p>

<p align="center">
  <a href="https://github.com/MorphEdit/Hx/releases"><img alt="Release" src="https://img.shields.io/github/v/release/MorphEdit/Hx"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 23.6+" src="https://img.shields.io/badge/node-%3E%3D23.6-339933">
</p>

Hx turns a GitHub repo's issues into merged pull requests.

You describe a feature in plain words, and Hx interviews you until it is clear. Then it:
- writes the plan;
- splits it into small issues;
- gives each issue to a fresh Claude Code session in its own git worktree.

A second session checks every change before it merges. You come back to working code.

It runs natively on Windows (and anywhere Node runs), with no tmux, no Docker and no database.

![Hx: one board, three workers](docs/figures/hx-flow.svg)

## How it works

1. **You describe it.** Type `/hx` in Claude Code, or use the `hx` command line. Hx asks one question at
   a time and writes a PRD (the plan).
2. **The plan is checked.** A critic looks for gaps and contradictions before any code is written.
3. **It is split into issues.** Each one is small, and its `## Blocked by` says what must land first.
4. **Workers build in parallel.** Each issue gets its own branch, a fresh session, tests, and a pull
   request.
5. **Every change is audited.** A separate session, which did not write the code:
   - checks each acceptance criterion against the diff;
   - runs the new tests on the old code to prove they catch the bug;
   - sends the work back when something is missing.
6. **It merges and keeps `main` green.** Tests run after every merge. A red `main` gets a fix issue
   before anything else.
7. **The whole feature is reviewed.** Once all its issues are closed, a review and a security pass check
   the PRD as a whole.

All state lives in GitHub: issues, labels, branches and comments. Stop at any time and resume later.

## Quick start

You need Node ≥ 23.6, `git`, the GitHub CLI `gh` (logged in) and Claude Code `claude`.

```bash
npx github:MorphEdit/Hx install
```

Then, inside your repo:

```bash
hx start "a habit tracker with a weekly chart"
```

`hx start` checks your setup, sets up the repo, interviews you into a PRD, shows the plan, and starts the
workers. Each step is skipped when it is already done. From Claude Code you can also type `/hx` and
describe what you want.

## Everyday commands

| Command | What it does |
|---|---|
| `hx start "idea"` | set up, plan and start, all in one |
| `hx grill "idea"` · `hx prd file.md` | turn an idea into a PRD · file one you wrote |
| `hx issue "small task"` · `hx bug "what broke"` | add one task or one bug to the board |
| `hx run --watch` | work the board and keep watching for new work |
| `hx status` | what is running and what is next |
| `hx dashboard --open` | the same, live, in your browser (localhost only) |
| `hx pause` · `hx pause --now` · `hx resume` | stop after the current work · stop now and save it · carry on |
| `hx service install` | start Hx at Windows logon, and restart it if it crashes |
| `hx usage --compare "time"` | did a change make Hx faster, cheaper or better? |
| `hx doctor` | check the setup, with a fix for anything missing |

Every command and setting is in the [guide](docs/guide.md).

## When hx needs you

Some things only you can do: make a choice, sign up for something, or try the result by hand. Then Hx
asks you on the issue, labels it `needs-human`, and works on everything else meanwhile.
- **A question** starts with **Hx needs your answer:**, then lettered choices, one marked
  *(recommended)*.
- **To answer**, add one comment to the issue: just the letter (`A`), or say what you want in your own
  words. Hx picks the issue up again from your answer.
- **Never paste a secret** (a key, a password) in a comment. Put it where the steps say (a local file or
  an environment variable), then reply `done`.
- **See what waits on you** at the top of `hx status` and in the dashboard's *Waiting on you* panel.
- **Questions are rare.** At most `maxOpenQuestions` (3) are open at once. Anything with a sensible default
  is decided for you and listed in the PR under `## Decisions made for you`; your answers are quoted
  under `## Owner decisions`.

## Does it work?

From real runs. The [benchmarks](docs/benchmark.md) page has the details and shows how to reproduce
them.
- **Six issues on a fresh repo:**
  - every arm passes 6/6 hidden tests the agents never saw;
  - three workers finish in 60% of the time one worker takes, for the same tokens.
- **Planted defects:** the auditor caught 6 of 6 bugs hidden in PRs whose own tests passed.
- **Hx building Hx:** after the audit got stricter, 20 closed issues had 0 bug issues and 0 reverts
  after merge.

## Safe by default

- **Only trusted authors reach a worker.** Issues from other accounts are shown but never run.
- **Workers are lean.** Each gets a short tool list and none of the MCP servers or skills installed on
  your machine.
- **The dashboard listens on localhost only.**
- **A self-update that fails to start rolls back.**

More in the guide's [Safety](docs/guide.md#security-only-trusted-authors-reach-a-worker) section.

## Documentation

| | |
|---|---|
| [Guide](docs/guide.md) | every command, the PRD flow, audits, the CI gate, releases, several repos, the config table |
| [Benchmarks](docs/benchmark.md) | how Hx was measured, and before/after numbers from real runs |
| [Design](docs/design.md) | why Hx works the way it does, and how it relates to Harness |
| [Contributing](CONTRIBUTING.md) | how changes are made, tested and released |

## Credits

The core ideas come from [VocanicZ/Harness](https://github.com/VocanicZ/Harness) (MIT):
- GitHub issues as the only state;
- the `## Blocked by` grammar;
- one worktree per issue;
- a Ralph loop ending on a `<promise>`;
- role-specific prompts.

Hx's code is written from scratch.

## License

MIT
