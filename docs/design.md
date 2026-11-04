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
| 7 CLI adapters | Claude Code only, behind the `AgentCli` seam (`src/agents/`) |
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
| 5 | Auditor per issue (#1) + CI gate (#4): audit eval 6/6 planted defects caught; benchmark 6/6 with the auditor on | done |
| 6 | Gauntlet (#3): a critic → reviser loop hardens a PRD before decompose; a security pass checks its merged work before it closes — critic eval 3/3 defects, security eval 3/3 vulnerabilities, no false alarms | done |
| 7 | GitHub rate limits (PRD #138): a budget reserve (`ghReservePct`), the `github` line, rate-limited calls waited out in `hx run` and (briefly) in the worker scripts, a shared fleet hold | done |
| 8 | Releases (PRD #139): `hx release` on a green gate (patch, minor once a PRD closed, major by hand), notes from git and GitHub, `autoRelease` in `hx run` | done |
| 9 | Onboarding (PRD #183): `npx github:MorphEdit/Hx install`, `hx doctor` and the `hx run` startup gate, `hx start`, `hx update`, the `/hx` skill | done |

### Next: the rest of Harness's features, ordered by how much they improve the quality of what Hx ships

Agreed order (2026-10-30), highest quality gain first. Build them in this order.

| # | Feature | What it adds | Notes |
|---|---|---|---|
| 1 | ~~**Auditor per issue**~~ done | a fresh session checks the implementer's work against the issue before merge; a failed audit goes back to the implementer | biggest quality gain; measure with the benchmark (hidden tests, tokens) |
| 2 | ~~**Grill session**~~ done | `hx grill` interviews the user until the PRD is unambiguous, then files it | interactive `claude`, not headless |
| 3 | ~~**Gauntlet / security audit**~~ done | PRD review in rounds with a critic, plus a security pass; gaps become issues | builds on the auditor; `gauntlet`/`gauntletRounds`, `security`/`securityRounds` |
| 4 | ~~**CI gate**~~ done | no new claims while the default branch is red; running sessions continue | Harness: `ci_gate_ok` |
| 5 | ~~**rtdd**~~ done | names the tests a change needs and the changed lines no test reaches | #34: rtdd v0.4.0 as a skill for `impl` and `audit`. Design choice: the orchestrator is code and needs no skills; skills are given per role through config (`roleSkills`) |
| 6 | ~~**Bug lane**~~ done | `bug` issues: a triage session, then a fix session; priority over normal issues | reuses auditor + CI gate; PRD #78: `hx bug`, a `<!-- hx:triage -->` verdict (REPRODUCED → `bug-triaged` + `ready-for-agent`, NEEDS-INFO → `agent-blocked`), `bugTriage`/`triageRounds` |
| 7 | ~~**Inject into a running fleet**~~ done | `hx prd/issue` while `hx run --watch` runs (grill → file) | PRD #97: `hx issue` grills one small task into one issue; `hx prd`/`bug`/`grill`/`issue` touch `.hx/wake`, which wakes `hx run --watch` within seconds (bypassing nothing), and end with one line on whether a runner will pick the work up |
| 8 | ~~**Web dashboard / stats**~~ done | read-only local page over `live.json`, `usage.jsonl`, the board; stats per PRD/role/model | `hx dashboard` (#37): 127.0.0.1 only, Host check, GET only, escaped text; outcomes from `.hx/run.log` |
| 9 | ~~**Author filter**~~ done | only issues (and PRDs) opened by trusted authors (the `gh` login plus `trustedAuthors`) are claimed; agents read issues via `scripts/issue.mjs` without untrusted comments; hx's marker comments only count from trusted accounts | moved ahead of #5 (#26): with workers on bypassPermissions, text from any GitHub account reaching a prompt was a prompt-injection hole, which outranks any quality feature |
| 10 | ~~**Multi-repo / multi-CLI**~~ done | one fleet over several repos; other agent CLIs | PRD #98: `hx fleet` runs one `hx run` per repo under a shared worker cap and usage hold; the `AgentCli` seam in `src/agents/` (claude only). See [Fleet and agent CLIs](#fleet-and-agent-clis-roadmap-10) |

### When Hx may build itself (self-hosting)

Harness builds itself: every issue in its repo is `[AFK]` and was done by its own fleet, and a failed
release gate files a bug that its bug lane fixes. It could do that because its engine had already
proven itself in another project, and because nothing merges unchecked.

Status (2026-10-30): **both done and measured** — audit eval 6/6 planted defects caught (5/6 correct PRs
passed, the sixth sent back for tests the issue asked for), CI gate shown end to end, benchmark 6/6 with
the auditor on. Self-hosting can start.

Hx was not used on its own repo until both of these existed **and were measured**:

1. **Auditor per issue (#1)** — an independent session checks each PR against its issue before merge.
   Measured by an audit eval: PRs with planted defects that pass their own tests, mixed with correct
   PRs. The auditor must catch the defects without blocking the correct ones.
2. **CI gate (#4, pulled forward)** — after each merge the default branch is tested; while it is red,
   nothing new is claimed except the issue that fixes it. Shown by an end-to-end test.

Then the benchmark is re-run with the auditor on (quality must stay 6/6; the token cost is reported).
Only after that: write PRDs for the remaining features and let `hx run --watch` build them, with the
human reviewing merged PRs. Self-healing (a red gate filing its own bug for the bug lane) comes with #6.

Every phase ships with tests; anything that can change quality or tokens is re-measured with
`node bench/run.mjs hx3` (and `hx1`/`chat` when comparing).

## Fleet and agent CLIs (roadmap #10)

`hx run` stays one process per repo; `hx fleet run` (`src/fleet.ts`) is only a parent that starts one
`hx run` child per repo listed in `~/.hx/fleet.json` and prefixes its output. Nothing moved into a
shared in-memory pool: every repo keeps its own runner lock, `.hx/`, pause and checkpoint path, and a
child keeps working if the parent dies. What the runners share goes through files in `~/.hx/fleet/`,
named to the children by `HX_FLEET_DIR` (and the cap by `HX_FLEET_WORKERS`):

- **Slots.** The cap is N files, `slots/<k>.json` for k in 0..N-1, each holding its owner's pid, repo
  and issue. A session takes the first free index by creating the file with `wx` (exclusive create, so
  two runners never get the same k) and deletes it when it ends; with no free slot the runner claims
  nothing this tick. A slot whose pid is dead (or that has stayed unparsable for 10 s) is stale: a
  runner takes it over only after it creates the marker `<k>.<id>.takeover` with `wx` and re-reads the
  slot under it, so two runners can never both delete and recreate it. Old markers are dropped after 60 s.
- **Shared hold.** `hold.json` holds `{ until, reason, repo }`. A runner that hits a usage limit, or
  passes `usagePauseAt`, writes it (only when its `until` is later, via a temp file and rename); every
  runner reads it each tick and copies it into its own hold (`live.pausedUntil`), never writing a copied
  hold back.
- **Shared GitHub hold.** `github-hold.json`, the same shape and rules. A runner whose GitHub API budget
  falls below `ghReservePct` becomes budget-low until the bucket's reset: no claims (engine steps
  included), no board reads, a wake every 2 × `pollSeconds` that re-reads the free `rate_limit`. It is
  kept apart from the usage hold, so a later caller (a call that hit the limit) can enter it too. Every
  runner reads the file at the top of each pass and before each claim and copies a future `until` into
  its own budget-low state, never writing it back.
- **Ctrl+C over IPC.** The children are `detached` (their own console) so a console Ctrl+C does not hit
  them all twice, and on Windows `child.kill('SIGINT')` kills a process outright. So the parent sends
  `{ type: 'interrupt' }` over the IPC channel and the child runs the same handler as its own Ctrl+C:
  first a checkpoint, then a force quit. The channel is unref'd, so it never keeps a child alive.

**The fleet dashboard** (`hx dashboard --fleet`) is one server, not one per repo. Its list of repos is
append-only: `~/.hx/fleet.json` first, then `~/.hx/repos.json`, which `hx init` and `hx run` update so a
repo shows up without being added by hand. Each repo's own dashboard is mounted under `/repo/<k>/`, where
k is an index into that server's own list, never a path from the request: a URL cannot name a directory,
and an entry keeps its k while the server runs even when the files change. The overview page
(`src/dashboard-fleet.html`) reads only `api/fleet`, sorts the cards itself and links each with its own k.

The agent CLI is a seam, not a feature: `AgentCli` in `src/agents/` (the argv of one headless turn, a
per-turn output parser, the interactive argv for `hx grill` / `hx issue`) is all `agent.ts`, `pool.ts`
and `cli.ts` know about the CLI, and `agentCli` in the config names the adapter. `claude` is the only
adapter; a second one is added when there is a real need for it, not before.

## GitHub rate limits (PRD #138)

Every runner, every worker and every fleet child uses one `gh` login, so they share one account's
GitHub API budget (5000 core and 5000 graphql points an hour). A busy fleet used to run it dry, and
then every `gh` call failed at once: claims, merges and the workers' `ship.mjs` alike. `src/ghlimit.ts`
holds the pure rules (parse `gh api rate_limit`, the `github` line, classify a failure as a primary or
secondary limit, how long to wait), so hx and the scripts cannot drift apart.

- **Reserve, not a race to zero.** `gh api rate_limit` costs nothing, so a run reads it at most once a
  minute. Below `ghReservePct` (default 0.2) of either bucket the runner is budget-low until that bucket's
  reset: no claims (engine steps included) and no board reads, while running sessions carry on with the
  rest. It wakes every 2 × `pollSeconds` to re-read the budget. The reserve exists for the sessions
  already running: a worker that cannot push or open its PR wastes the whole session. `0` turns it off.
- **Waiting only inside a real `hx run`.** `github.ts` waits and retries a rate-limited call only while a
  wait signal is set, and only `hx run` sets it, after `--dry-run` has returned. Every other command
  (`hx status`, `hx issue`, `hx run --dry-run`, …) is run by a person who is watching and should see the
  error now, not a silent hang until the reset. Ctrl+C ends a wait without a retry.
- **90 s cap for the worker scripts.** `ship.mjs` and `issue.mjs` (`scripts/ghwait.mjs`) apply the same
  waits, but a worker runs them through Claude Code's Bash tool, which kills a command after a few
  minutes, and a killed `ship.mjs` leaves the session not knowing what happened. So the total wait per
  script run is capped at `HX_GH_WAIT_MAX_SECONDS` (default 90 s): a short secondary limit is ridden
  out, while a wait that would pass the cap is not started and the script fails with its usual code
  (`rate limited until HH:MM`), leaving the long wait to the runner.
- **One shared fleet hold.** The budget is per account, not per repo, so a runner that goes budget-low
  or waits out a limit writes `github-hold.json` in the fleet dir and every other runner copies it into
  its own budget-low state. It is kept apart from the usage hold (`hold.json`): the two have different
  causes and resets, and lifting one must not lift the other.

## Releases (PRD #139)

`hx release` and `autoRelease` (`src/release.ts`) turn merged work into versions. The decisions:

- **Gate at G.** A release is made only on a green gate result, and on the gated commit (G), never on
  whatever the branch head is at push time. `hx release` uses the gate even when `gate` is off: a
  version is a promise that its commit passes.
- **No rebase.** The version commit sits on G and goes with its tag in one atomic push. If the branch
  moved, a rebased version commit would carry ungated changes, so hx tags G itself and skips the bump.
- **Nothing stored.** The next version, whether a release is due and whether one is missing are all
  read again from origin's tags, the first-parent commits and the closed PRDs. No state file can drift
  from GitHub, a crash mid-release is repaired by the next run (a tag without its release gets only
  the release), and `hx release` and `autoRelease` cannot disagree.
- **Only the run's gate writes `gate.json`.** A gate run made for a release is never recorded and files
  no fix issue: its result must not change what `hx run` claims. Inside `hx run` with `gate` on, the
  release waits for the run's own gate instead of running a second one.
- **Notes with no AI.** The notes are grouped from conventional commit subjects and the closed PRDs'
  titles, so they cost no tokens and say only what merged; there is no changelog file to conflict on.
- **autoRelease** checks after merges and PRD closes, in the background: a minor release per closed
  PRD, a patch release at most every `autoReleasePatchHours` while fixes merge. `hx release` refuses
  while `hx run` runs, so two releasers never race.

## Onboarding (PRD #183)

Getting from nothing to a running board takes one install line and one command. The decisions:

- **`github:` npx install, no registry.** `npx github:MorphEdit/Hx install` fetches the repo and runs
  `bin/install.mjs`, which `npm install -g`s `github:MorphEdit/Hx#<tag>` (the latest release tag, or
  `--version`). A release is a git tag already (see Releases), so nothing is published twice and there is
  no npm account to guard. `hx update` is the same routine; both check that `hx` runs from PATH, then run
  `hx doctor`. An `npm link` of a checkout is left alone unless `--force`.
- **The Node check comes before any `.ts` loads.** `bin/hx.mjs` imports only `.mjs` statically; it runs
  `bin/node-check.mjs` first, so an old Node prints the version it needs and how to get it on this OS
  instead of a syntax error. `install` / `update` run before the hook below, so they load no `.ts` either.
- **Raw `.ts` from `node_modules`, no build, no dependency.** Node refuses to strip types under
  `node_modules`. `bin/strip-hook.mjs` registers a synchronous load hook (`module.registerHooks`) that
  strips hx's own `.ts` files with `module.stripTypeScriptTypes`; every other URL goes to the next loader.
  The installed package is the repo as it is: no build step to forget, nothing compiled to drift.
- **Doctor's marks.** `src/doctor.ts` checks node, git, the `gh` login, the agent CLI, the repo's GitHub
  origin, `.hx/config.json`, the labels, the gate and rtdd, each with a fix for this OS. `✓` passed; `✗` a
  required check failed (exit 1); `–` informational or optional (the agent CLI login cannot be checked
  without spending usage, rtdd is optional); `?` could not tell (offline, a timeout), which never blocks.
- **The `hx run` startup gate.** `hx run` runs the same checks (without the label lookup: it creates the
  labels) and stops on a required `✗` before it claims anything, printing only the lines that are not `✓`.
  A `?` is printed and the run starts: being offline for a moment must not stop a fleet.
- **`hx start`** chains doctor → init → grill → the dry-run plan → `Start N worker(s) now? [Y/n]` →
  `hx run --watch`, each step skipped when already done (a config exists, an open PRD or ready issue is
  on the board), so running it again is safe. It reuses the commands; it adds no state of its own.
- **The skill template lives in `templates/`.** `hx install-skill` writes `templates/hx-skill.md` to
  `~/.claude/skills/hx/SKILL.md`, so a user can ask Claude Code to build with hx. It is not under
  `prompts/skills/`: those are notes appended to worker prompts, this is a skill for the user's own session.

## Models per role

`roleModels` (PRD #129) gives a role its own model and effort, but it is opt-in: the default is `{}`, every
role on `model` / `effort`, and no default changes until a benchmark run shows a cheaper model on a role
keeps the quality. The guard is the mismatch check: the CLI reports the model that ran each turn
(`actualModel` in `usage.jsonl`), and a session whose turn ran on another model than it asked for (by
`modelMatches`: the same id, a dated id of it, or a bare alias's family) logs one
`model mismatch: <role> asked <x>, ran <y>` line and goes on. The count surfaces in the dashboard's
outcomes and in `hx status`, so a silent fallback to another model is seen instead of skewing quality or
token numbers. Checkpoint turns resume the session's own model and do not count.

## Budget gate

`usagePauseAt` stops claiming only once a window is already full, so the last sessions started below it
can still run it out. The budget gate (PRD #130) asks before each claim whether the session fits. Every
usage-window reading the CLI reports is appended to `.hx/usage-readings.jsonl` (deduplicated against the
file's last reading of that window). Calibration pairs consecutive readings of a window with the same
`resetsAt` and a rise; the cost of every usage record between them, checkpoints included, divided by the
rise gives dollars per 1%. A window is calibrated once it has `budgetMinPairs` such pairs, and its rate
is the p20 of the fits: a low rate gives a high percentage, so the gate errs on the side of skipping. A
role's forecast is the p80 of its past session costs (every role's sessions when it has fewer than three;
none when there are fewer than three in all). An action's forecast is the sum of the roles it starts in
one round: impl + audit when audit is on, critic + revise for the gauntlet, the role itself otherwise;
engine steps (`close-prd`, `label-ready`) have none and are never gated. Percentiles are nearest-rank, so
every one is a cost that was actually seen. The gate skips an action when, in any calibrated window with an
unexpired reading, used% + forecast% passes `usagePauseAt`; a reading past its `resetsAt` counts as 0%.
A skipped action is looked at again on the next poll, later actions that fit are claimed in order, and
running sessions are never stopped. No forecast or no calibrated window means no gate: with too little
history Hx claims exactly as before. The pure functions live in `src/budget.ts`; the claim loop reads the
two files once per pass.

## Worktree setup

A worktree holds only tracked files, so in a normal project the first session and the gate start
without dependencies or a `.env` (PRD #137). `worktreeCopy` copies named untracked files in and
`worktreeSetup` runs one command (`npm ci`) in each worktree hx creates; `src/setup.ts` does both.
Decisions:
- Setup runs after `addWorktree` returns, outside the worktree queue: an install can take minutes, and
  holding the queue would stall every other worker's add and remove. Parallel setups each run their own
  command.
- A per-directory record (`.hx/logs/setup-<name>.json`) is written when a session's setup finishes, so
  only a setup that succeeded counts as done: a reused impl worktree whose record is missing (interrupted)
  or failed is set up again. A failed setup does not block the session; its prompt gets a setup note.
- The gate retries a failed setup immediately, within one `gateCheck`, up to 3 times at one sha. Waiting
  for the next poll would not help: the next merge moves the sha, and a flaky install should not turn the
  base red. Three failures at one sha make it red with a fix issue that names the setup command.
- Copied files are added to the shared `info/exclude`, never committed: they are local (secrets, machine
  config), and a session must not ship them.
- No shared dependency folders (a symlinked `node_modules` and the like): each worktree installs its own,
  and the package manager's cache makes that fast enough without one worktree's install breaking another.

## Line endings (#252)

CRLF broke work three times (#204, #223, #238): a worktree checked out under `core.autocrlf=true`, or a
session that wrote CRLF, gave diffs on every line, rebase conflicts on untouched lines and failing text
comparisons. Decisions:
- LF is enforced in three places, because each catches what the others miss: `.gitattributes`
  (`* text=auto eol=lf`) for every clone, the worktree's own config for repos without one, and `ship.mjs`
  for files a session writes with CRLF.
- The worktree settings go in `config.worktree` (`git config --worktree`), and the checkout itself runs
  with `-c core.autocrlf=false -c core.eol=lf`, so the first checkout is LF too. The user's global and
  system config are never written: other repos on the machine keep their settings.
- `ship.mjs` converts only files `.gitattributes` marks `eol=lf` and not binary: `text=auto` alone does
  not renormalize a file whose committed copy already has CRLF.
- The doctor line is informational: a repo that wants CRLF is the user's choice, not a broken setup.

## Test runs (#223)

The full suite runs once per ship: `ship.mjs` runs the `--test` command after the rebase, on exactly what
will be merged, and the gate runs it again on the default branch after each merge. Workers do not.
Decisions:
- While working, the implementer runs only the affected tests: the test files for the changed code, the
  tests `rtdd which` names when the rtdd skill is loaded, and any test file the issue names. It never runs
  the full test command before shipping, and runs the full suite only to check a failure ship.mjs reported
  (exit 4), once before shipping again. The continue prompt, the resume note and the audit-return note say
  the same.
- The auditor also runs only the affected tests: the gate and ship.mjs cover the full suite.
- Why: on #204 a worker ran the full suite three times (20–25 minutes each with 3 workers busy), ship.mjs
  ran it a fourth time, and the turn hit its time limit while shipping. A longer `turnTimeoutMinutes` does
  not fix that; running the suite once does.
- Unchanged: at least one test must fail without the change, and no test is deleted, skipped or weakened.

## Audit depth (#233)

Audits were shallow: over 145 audits 3 failed (2%) while `main` went red 13 times after a merge, and an
auditor could PASS after reading only the diff, with `FINDINGS: none`. Decisions:
- The audit prompt says what an audit must read: the issue and its parent PRD (through `issue.mjs`), the
  full diff, every changed file in full, the callers and callees of the changed code (`grep`), and the parts
  of `CLAUDE.md`, `docs/design.md` and the README the change touches. "Read only what you need" is gone.
- It also checks the change fits the design and the other callers, that docs and `hx help` follow a
  behaviour change, and runs each new or changed error path by hand.
- A PASS lists every acceptance criterion with its evidence (file and line, command run, what it printed);
  `none` is no longer allowed. The verdict parser is unchanged and the PASS comment shows those lines.
- Unchanged: FAIL only for a real defect against the issue, and only the affected tests are run.
- The implementer reads the parent PRD and the parts of `docs/design.md` and `CLAUDE.md` the issue
  touches before coding.

## Test time (PRD #182)

How long workers spend in tests, and how long the gate takes, so a slow suite shows up before it costs turns.
Decisions:
- Test time is derived from the stream-json events hx already logs: a test command's span runs from the
  assistant event with its `tool_use` to the user event with its `tool_result`, clipped to a turn window taken
  from hx's wall clock (when hx started the turn and when it ended) and merged where spans overlap. There are
  no new hooks, no new sessions and no new tokens: nothing is asked of the agent.
- What counts as a test is a pattern match on the shell command (defaults in `src/timing.ts`, the effective
  gate command, `testPatterns`). A suite run through a wrapper script is missed unless the repo adds a
  pattern; a false match only over-counts one command.
- Missing data is unknown, never 0: records written before this have no `testMs` and show as `-`.
- The pool gate appends one line per run to `.hx/gate-runs.jsonl` with the test command's duration only
  (setup excluded); the release gate is not recorded. The slow-gate warning compares the median of the last 5
  with `gateMinutes`, since a gate near its timeout turns red under load.

## Where the suite's time goes (#234)

`npm run test:profile` runs the suite with `test/profile-reporter.mjs` next to the spec reporter: it writes every
test's file, name and duration (slowest first) to `test-profile.json` and prints the 20 slowest.
Findings (2026-11-04, 12 cores, 3 workers busy; the suite runs 11 files at a time, `--test-concurrency` default):
- Baseline: 622 tests, 824 s wall, 7942 s summed over tests. Nearly all of it is end-to-end tests; the slowest
  files (`session-setup`, `release-cmd`, `role-models`) sum 530–560 s each.
- One full PRD run traced (`roleModels {}`: decompose, four impl + audit sessions, two reviews; 59 s): no long
  waits. Git calls, fake `gh` and fake `claude` follow each other with gaps of 150–450 ms, the start-up of each
  process; gaps over 150 ms add up to 16 s. The only multi-second gap is the first board read after startup.
  hx's waits (`pollSeconds: 1`, `HX_SHIP_RETRY_MS`, fetch retries) are already short or never hit.
- So the cost is the number of processes times the cost of each start. Each call through `exec.ts` set
  `windowsHide`, which gives every child a hidden console of its own: a gh + git pair took 1012 ms median
  against 604 ms when the child shares the parent's console (40 alternating pairs in one process, same load).
- Git: `git maintenance run --auto` ran after each fetch, commit and push (41 times in one PRD test).
Decisions:
- `HX_SHARE_CONSOLE=1` (set by `test/isolate.ts`) turns `windowsHide` off for hx's own calls (`exec.ts`,
  the agent process, the doctor probes). Real runs keep it: a fleet's detached runner has no console to share.
  Two e2e files run side by side under the same load: 158 s with it, 219 s without (−28%).
- The tests' git config turns off auto gc, maintenance, commit-graph writes on fetch and fsync, and every node the
  tests start shares one `NODE_COMPILE_CACHE`.
- The fake `gh` answers in-process: `test/fakes/gh.mjs` exports `gh(args, { input, cwd })`, and when
  `HX_GH_INPROC` (set by `test/isolate.ts`) names that file, `src/exec.ts` (hx's calls) and `scripts/ghwait.mjs`
  (ship.mjs, issue.mjs) call it instead of starting node for each call. A full PRD run made ~110 gh calls; the PRD
  test alone went from 17.9 s to 12.3 s. The answers, board changes and recorded calls are the same as the
  program's (`test/gh-inproc.test.ts` runs one set of calls both ways); a call with its own env, or a slow read
  the fake keeps for the program, still starts one. Real runs never set `HX_GH_INPROC`.
- A fleet's detached runner has no console to share, so `startFleetRun` drops `HX_SHARE_CONSOLE` from its env.
- Not done: creating the missing labels in parallel (GitHub asks for mutating calls one at a time), a shared seed
  repo (git setup is a few calls per file, not where the time goes).

Before / after (2026-11-04, 3 workers busy, not idle): the 20 slowest tests of one `npm run test:profile` run
of the branch, each run alone (`--test-name-pattern`) once on `origin/main` (f6844b6) and once on the branch,
the pair side by side under the same load. The PRD flow test needs the test before it in its file, so both ran.
Summed: 528.6 s → 281.7 s (−47%). The full suite on an idle machine is timed by the maintainer.

  | test | before (s) | after (s) |
  |---|---|---|
  | `fleet-run.test.ts` hx fleet run: every output line carries the [owner/name] prefix of its repo | 8.3 | 6.5 |
  | `fleet-run.test.ts` interrupt(): both children checkpoint their running sessions and exit; done resolves to t… | 8.4 | 8.4 |
  | `role-models.test.ts` roleModels {}: every session gets --model and --effort as before; no models: line; live.j… | 24.4 | 15.2 |
  | `bug-note.test.ts` bugTriage false: a bug runs impl without triage, both prompts carry their note, it merges… | 13.7 | 7.4 |
  | `role-models.test.ts` impl and audit set: their sessions get their model and effort, a PRD role the default; us… | 27.9 | 17.4 |
  | `audit.test.ts` audit PASS but the merge hits a rebase conflict: logged and commented, back to the implem… | 11.4 | 6.9 |
  | `audit.test.ts` audit FAIL: the findings go back to a fresh implementer, then PASS and merge | 9.3 | 4.9 |
  | `pool.test.ts` PRD flow: decompose → build → review (gap, then sign-off) → close, PRDs sequenced | 26.8 | 21.2 |
  | `actual-model.test.ts` records carry actualModel when the CLI reports it (a dated id of the asked model: no mism… | 14.0 | 6.6 |
  | `session-setup.test.ts` every session worktree is set up before its first turn: impl, audit, triage, gauntlet cri… | 54.2 | 25.0 |
  | `audit.test.ts` audit PASS: hx merges the PR the implementer left open | 21.8 | 14.6 |
  | `gate-setup.test.ts` the sha changes between setup tries: the count restarts at 1 | 27.1 | 15.4 |
  | `auto-release.test.ts` autoRelease: a run in which a PRD closes releases a minor (PRD #n) on the run's own gate … | 23.9 | 9.6 |
  | `gate.test.ts` main moves while the fix session is still finishing: the gate waits for that session, not… | 25.3 | 20.4 |
  | `session-setup.test.ts` worktreeSetup "" and no worktreeCopy: no setup line, no setup-* file, prompts as before | 40.8 | 21.9 |
  | `audit.test.ts` audit keeps failing: after auditRounds the issue goes to a human, nothing is merged | 27.9 | 9.1 |
  | `security.test.ts` security files an issue → prd-reviewed removed → fixed → review again → security PASS → P… | 49.0 | 17.6 |
  | `auto-release.test.ts` patch: only feat: / docs: / other commits → no release | 18.2 | 9.2 |
  | `fleet-hold.test.ts` a rate-limit event in repo A writes hold.json; repo B copies the hold and claims nothing … | 85.7 | 39.5 |
  | `audit.test.ts` a repo that only takes auto-merge: hx waits for it to land instead of failing the issue | 10.4 | 5.0 |
  | **sum of the 20** | **528.6** | **281.7** |

## Self-check (PRD #194)

When the board runs dry, hx runs a health pass over its own state and, after a quiet period, a self-review of
what merged. Decisions:
- **Pure checks over one snapshot.** `src/health.ts` reads one snapshot (issues, PRs, trusted comments, live
  sessions, worktrees with mtimes, `gate-runs.jsonl`, `health.json`, the head sha, the time) and each check is a
  pure function from it to results and actions; the runner applies the actions, or only describes them
  without `--fix`. Every check is tested without GitHub. The checks run in a fixed order and share a `seen` set,
  so two checks never act on the same issue in one pass.
- **Only the second resume files an issue.** The blocked-after-PASS check repairs an issue once
  (`<!-- hx:health resume -->`); blocked again, the merge path itself is failing, which a PR can fix, so it
  files one `health:` bug, found again by its `<!-- hx:health <key> -->` marker among closed issues too, so
  it is never refiled. Every other ✗ waits for time or a gate run (it resolves itself on a later pass) or is
  about the machine (doctor, disk), which no agent fixes through a PR: filing those would flood the bug lane.
- **"Twice green" is read from `gate-runs.jsonl`**, the only record of more than one gate run. On an idle board
  the head never moves and the pool re-runs the gate on a moved head only while it is red, so waiting for a
  second run would wait forever. A pass in `hx run` with repairs on asks the runner's own gate check for one
  more run when the last line is green but the last two are not both green at the head, never while one is
  running; the next pass decides. `hx health` never starts a gate run.
- **The unblock time lives in the comment marker** (`<!-- hx:health unblock <time> -->`): `commentBodies`
  returns bodies without timestamps, so the once-per-24 h rule needs no new GitHub field and no local file,
  and survives a lost `.hx`.
- **Self-review only inside `hx run`, never with `selfHeal: false`.** It spends usage on an agent session, so
  it runs only where holds, the budget gate and the fleet's worker slots apply, only after a pass that left
  an empty board as it was, and only when the maintainer has left repairs on. `hx health` is a quick,
  deterministic look and starts none. Its findings go through the bug lane, so triage drops what does not
  reproduce before anything is built.

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
