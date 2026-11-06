# Hx benchmarks

How Hx was measured: the same issues run three ways and graded by hidden tests, planted-defect evals for
the auditor, critic and security pass, the project-sized benchmark, and before/after numbers from real runs.
Back to the [README](../README.md).

## Six issues, three ways

The same six issues (a small text-utilities library and its CLI, with a `Blocked by` graph:
`#2` and `#4` need `#1`, `#5` needs `#2 #3 #4`, `#6` is independent), each on a fresh GitHub repo,
three ways. Every run is graded by **hidden tests the agents never saw**. Real runs, not a mock-up:
the figures are drawn (and animated) from the logs in [`bench/results/`](../bench/results).

![Hx: one board, three workers](figures/hx-flow.svg)

![Timeline: the same 6 issues, three ways](figures/bench-timeline.svg)

![Benchmark summary](figures/bench-summary.svg)

| | Single session | Hx · 1 worker | Hx · 3 workers | Hx · 3 workers + auditor (default) |
|---|---|---|---|---|
| How | one Claude session does all 6 in a row | a fresh session per issue, one at a time | fresh sessions, in parallel where `Blocked by` allows | the same, and every PR is audited by a second session before hx merges it |
| Wall time | **3.2 min** | 6.0 min | 3.6 min | 5.5 min |
| Tokens | 0.67M | **0.40M** | **0.40M** | 0.69M |
| Sessions | 1 | 6 | 6 | 12 |
| Issues closed · PRs merged | 6 · 6 | 6 · 6 | 6 · 6 | 6 · 6 |
| Hidden tests | 6/6 | 6/6 | 6/6 | 6/6 |
| Independent check before merge | no | no | no | **yes** |

`claude-opus-5-5`, medium effort, 2026-10-30. No human input after the start in any run.

**What this shows:**

- **Phase 4 cut Hx's tokens by 84%** (2.45M → 0.40M for the same six issues, same hidden-test score).
  Every Hx session used to pay a ~44K-token base context on every call — the system prompt plus 44
  tools, 32 MCP servers and 78 skills installed on the machine, none of which a worker needs. Lean
  workers start at ~8K, and one `ship` script replaces the 5–6 calls the commit → rebase → test →
  PR → merge routine took.
- **The auditor costs about 0.05M tokens and 30 s per issue**, and is now on by default. These six
  issues were all done right first time, so here it only adds cost; what it is for is measured below.
- **Parallelism works:** 3 workers finish in 60% of the time of 1 worker for the same tokens.
- **The single session is still faster on six tiny issues** (one warm session never re-reads the repo)
  but has no second pair of eyes, and its cost per call grows with the project.

## Does the auditor catch real mistakes?

[`bench/audit-eval.mjs`](../bench/audit-eval.mjs): for each of the six issues, one correct PR and one with
a **planted defect** that breaks a rule or an example stated in the issue while the PR's own tests still
pass (the way a careless implementer's tests would). Twelve independent audits, in random order, not
told which is which ([results](../bench/results/audit-eval.json)):

| | |
|---|---|
| Planted defects caught | **6 / 6** — each with the exact rule, the wrong output, and how it was seen |
| Correct PRs passed | 5 / 6 |
| Cost | ~45K tokens and ~30 s per audit |

The one correct PR sent back (#1) was sent back for a real reason: the issue says "Add tests for these"
about six examples and the PR tested three. The auditor said the code itself was correct and named the
missing tests; in a real run that costs one more implement round.

## Do the gauntlet critic and the security pass catch real problems?

Same method, on smaller sets: each case gets one independent session, run in random order and not
told which cases are planted. Everything runs locally against a fake `gh`.

[`bench/critic-eval.mjs`](../bench/critic-eval.mjs) gives the critic PRDs for the benchmark project. Three have a
planted defect: an undefined "short word", rules that say round down while the example rounds up, and an
error case with no exit code. One PRD is clean. [Results](../bench/results/critic-eval.json).

[`bench/security-eval.mjs`](../bench/security-eval.mjs) gives the security pass a merged PRD with one planted
vulnerability: an issue title in an `execSync` shell command, an issue title used as a path that is later
`rmSync`'d, or `GH_TOKEN` written to a debug log. A clean PRD is in the set too.
[Results](../bench/results/security-eval.json).

| | Critic | Security pass |
|---|---|---|
| Planted problems caught | **3 / 3**, each finding naming the exact gap | **3 / 3**, one issue each, with file:line and an exploit scenario |
| Clean cases passed | 1 / 1 | 1 / 1 |
| Cost | ~29K tokens and ~17 s per critic | ~66K tokens and ~40 s per pass |

In the real run that built the gauntlet, the security pass also found a prompt injection in the
gauntlet's own critic and reviser prompts (MorphEdit/Hx#26). Hx fixed it before the PRD closed.

Before the auditor (same issues, same model): Hx · 3 workers 3.6 min / 0.40M tokens
([`bench/results/phase4/`](../bench/results/phase4)); before phase 4: 3.6 min / 2.45M
([`bench/results/phase3/`](../bench/results/phase3)).

Reproduce (creates private repos on your GitHub account and spends real usage):

```bash
node bench/run.mjs chat
node bench/run.mjs hx1
node bench/run.mjs hx3
node bench/audit-eval.mjs
node bench/critic-eval.mjs
node bench/security-eval.mjs
node bench/figures.mjs
```

## Project benchmark

Every arm scores 6/6 on the six issues, so they cannot show whether a change makes the result better
or worse. The project benchmark runs one end-user brief through the whole PRD flow (the gauntlet,
decompose, `Blocked by`, impl, audit, gate, review, the security pass), against a single session as the
baseline. The brief is `tally`: a time-tracking library and CLI with `start` / `stop` / `status` /
`add`, day, week and project reports with rounding, overlap detection, CSV export and a strict parse of
the log with line-numbered errors. Each run is graded by 80+ hidden tests the agents never see.

Run it (creates a private repo on your GitHub account per arm and spends real usage, up to the caps:
4 h and $60 per arm by default):

```bash
node bench/project.mjs chat --max-hours 4 --max-usd 60
node bench/project.mjs hx3 --max-hours 4 --max-usd 60
node bench/figures.mjs
```

`bench/figures.mjs` writes the table below from `bench/results/project-*.json`.

<!-- project-bench:start -->
| Arm | Hidden passed | Wall time | Tokens | Cost | Sessions | Issues closed/filed | Audit FAILs | Gate reds | Escaped defects | Capped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chat | 149/149 | 56.7 min | 0.77M | $1.06 | 1 (chat 1) | 0/0 | – | – | 0 | no |
| hx3 | 149/149 | 122.0 min | 4.04M | $6.38 | 19 (critic 2, revise 2, decompose 1, impl 6, audit 6, review 1, security 1) | 5/5 | 1 | 0 | 0 | no |
<!-- project-bench:end -->

**First run, 2026-11-06** (`claude-opus-5-5`, medium effort, both arms):
- **Correctness:** both arms passed all 149 hidden tests, and neither had an escaped defect.
- **Speed and cost:** the single session was about twice as fast and six times cheaper. The brief fits in
  one session (57 min, 0.77M tokens), so Hx's extra steps had nothing to catch. Those steps are 2
  gauntlet rounds, a split into 5 issues, an audit per issue, a review and a security pass.
- **The audit did catch one first attempt.**
- **Load:** the hx3 arm ran on the same 12-CPU machine while Hx was building itself with 3 more workers,
  so its wall time is an upper bound.

What this says: for a project that one session can finish, a single session is the cheaper choice. Hx is
built for work that does not fit one session, and for a board of many issues run unattended. A brief of
that size is the next benchmark to add.

## Real runs: before and after a change

The benchmark above is six small issues. These numbers come from the fleet building Hx itself
(`MorphEdit/Hx`, `claude-opus-5-5`, 3 workers), read from `.hx/usage.jsonl` with
`hx usage --compare`, so no tokens are spent to get them. Each row compares the runs before and after a
cutover. The samples are small (20 and 8 closed issues), so read them as a direction, not a verdict.

**What changed at the cutovers:**
- **2026-11-04 10:10:**
  - faster end-to-end test fakes;
  - audits read the whole change and show evidence for each criterion;
  - the health pass and the self-review.
- **2026-11-05 00:17:**
  - a "pre-existing failure" needs proof from the base commit (#250);
  - the auditor runs the new tests on the reverted code and must see them fail (#251);
  - LF line endings (#252);
  - self-update (#253, off by default).

| Board | Before 10:10 | After 10:10 | After 00:17 |
|---|---|---|---|
| Issues closed | 103 | 20 | 8 |
| Tokens per closed issue | 1.3M | 2.5M | 1.4M |
| Cost per closed issue | $1.70 | $2.30 | $1.34 |
| Audit FAIL share | 2% | 17% | 0% |
| Sessions stopped: timed out | 6 | 3 | 0 |
| Sessions stopped: not mergeable | 4 | 0 | 0 |
| Rebase test retries | 21 | 0 | 0 |
| Median audit session | 5m06s | 2m54s | — |

"After 00:17" counts only the last batch. Its own "before" column (all earlier runs) is 1.5M tokens and
$1.83 per issue, with a 5% audit FAIL share.

**Escaped defects.** Speed counts as a win only if this does not rise. These are problems found after a PR
merged, per closed issue:

| | Before 10:10 | After 10:10 |
|---|---|---|
| `bug` issues filed after a merge | — | 0 |
| `security` issues | — | 0 |
| PRD review gaps (a PRD sent back after all its children closed) | — | 0 |
| Gate-fix issues (`main` red after a merge) | 13 (13% of issues) | 2 (10%) |
| Reverts of a merged PR | — | 0 |

Both gate-fix issues after 10:10 were old tests that were fragile, not new code that was wrong. Both were
fixed at the cause, with a new test that reproduces it and no test weakened:
- **#266:** the dashboard gave up on a port Windows had reserved (`EACCES`); it now treats such a port
  like one in use.
- **#271:** `healthEveryMinutes` was counted from the start of a slow pass; it is now counted from the end.

**Reading it:**
- The audit got stricter after 10:10. It sent back 17% of first attempts, against 2% before.
- Merges got clean: no rebase retries and no unmergeable stops since 10:10.
- That rigour cost tokens at first, $2.30 against $1.70 per issue. The latest batch came in below the old
  cost, $1.34 per issue with every audit passing first time.
- The self-review records its starting commit on its first run and only reviews what merges after it.
  Its findings for this batch will show in the next comparison.

### Higher effort (2026-11-05 13:19)

The owner has spare quota and wants quality first. The cutover raised the models' effort:
- impl from medium to high;
- audit, review, security, critic, revise, decompose and triage from high to xhigh;
- `turnTimeoutMinutes` from 75 to 120.

Measured on 2026-11-06 with `hx usage --compare "2026-11-05 13:19"`, over 53.9 h of runs before and
10.8 h after:

| Board | Before | After |
|---|---|---|
| Issues closed | 131 (2.4 / h) | 22 (2.0 / h) |
| Tokens per closed issue | 1.6M | 6.1M |
| Cost per closed issue | $1.89 | $4.54 |
| Audit FAIL share | 5% | 13% |
| Impl sessions that failed | 26 of 210 (12%) | 3 of 36 (8%) |
| Sessions stopped: timed out | 11 | 0 |
| Gate-fix issues per hour of runs | 0.32 | 0.19 |
| Rebase test retries | 23 | 0 |

**Reading it:**
- **More real bugs caught:** the stricter audits caught them before merge. Examples:
  - #292: a closed issue with no PR was taken as done;
  - #293: the whole turn was posted as the question;
  - #316: a crash inside the self-update window did not roll back;
  - #328: the kill by command line was missing.
- **Fewer stops and reds:** no timeouts, fewer failed sessions and fewer red gates.
- **The cost:** about 2.4× the tokens per issue, and slightly fewer issues per hour.
- **Escaped defects:** no reverts and no `security` issues. The one `bug` issue, #328 (leftover test processes
  after a timeout), was filed by hand. It is about older code, not a change merged after the cutover.


## Test suite speed

How long `npm test` takes, test by test, before and after a change that targets it. Each change measures its two
profiles back to back on the same machine, while `hx run` works next to it: the "before" in a worktree of `origin/main`,
the "after" on the change's branch. The command is `npm run test:profile -- --test-concurrency=<k>`, the same both times.
The times are summed test time from `test-profile.json`. On a shared machine they change with the load, so a row
is a direction, not an exact saving. Each change appends its own rows below, under its PR number, and leaves earlier
rows alone.

**Runs:**

| PR | Date | `--test-concurrency` | `workers` line (before run) | `workers` line (after run) | Suite wall time (before → after) | Summed test time (before → after) |
|---|---|---|---|---|---|---|
| #354 | 2026-11-06 | 3 | `3/3 (auto: cpu 50%)` | `3/3 (auto: cpu 49%)` | 1173 s → 915 s | 11992 s → 9054 s (−25%) |

**#354: what changed.** These three cuts apply to every end-to-end run:
- the pool waited a fixed 2 s after a pass that only closed a PRD or labelled a child. `HX_ENGINE_RETRY_MS` now sets
  this wait, and `test/isolate.ts` sets it to 50 ms. Every PRD run ends with one such pass;
- `hx doctor`'s probes (`gh auth status`, `gh repo view`, `gh label list`) ran the fake gh as a node process. Now they
  answer in-process, like every other gh call in the tests. That saves three node starts at each `hx run` start and
  each health pass, including in child runners;
- the fake claude's ship test command was `node -e "process.exit(0)"`. It is now the shell builtin `exit 0`, which
  saves one node start per `ship --no-merge`, `ship --resume` and gate run.

The rest of the suite, which these cuts barely touch, also fell 23% in the same pair of runs (9592 s → 7359 s): the
machine was less busy during the "after" run. Measured against that, the cuts are worth roughly 6 points of the top
20's 29%. The rest of the time in these tests is real work. A PRD run starts about 200 processes: git (worktree add,
fetch, push, rebase), a fake claude per session and a `ship.mjs` per merge. A loaded machine makes each start several
times slower: one test took 24 s alone and 135 s in the suite. Cutting further means fewer sessions or fewer git
calls per run, which would change what a test covers.

**Per test** (the 20 slowest of the "before" profile; seconds of test time):

| PR | Test file | Test | Before | After | Change | Why not more |
|---|---|---|---|---|---|---|
| #354 | pool | PRD flow: decompose → build → review (gap, then sign-off) → close, PRDs sequenced | 177.5 | 117.8 | −34% | the full flow of two PRDs is what it tests: every session and merge in it is real git work |
| #354 | session-setup | every session worktree is set up before its first turn: impl, audit, triage, gauntlet critic + reviser, decompose | 160.8 | 91.6 | −43% | each role must run once, in its own set-up worktree |
| #354 | role-models | roleModels {}: every session gets --model and --effort as before … | 155.0 | 111.1 | −28% | already lightened (#361): one PRD child, one standalone issue for the size turn |
| #354 | merge-held | a PASSed PR failing only test X, which main fails too: held … | 154.6 | 104.0 | −33% | runs a real red gate and a real held merge, then a green gate and the merge |
| #354 | audit | auditRounds 1: an audit PASS then two merge failures is still retried, not failed | 144.2 | 98.6 | −32% | three impl + audit + ship rounds are the case it tests |
| #354 | audit | audit PASS but the merge hits a rebase conflict: a merge round … then merged | 127.7 | 85.8 | −33% | two full impl + audit + ship rounds |
| #354 | bug-note | bugTriage false: a bug runs impl without triage, both prompts carry their note, it merges … | 126.7 | 81.2 | −36% | two runs (triage on and off), each through impl, audit and merge |
| #354 | role-models | impl and audit set: their sessions get their model and effort … | 123.5 | 82.2 | −33% | already lightened (#361) to one PRD child |
| #354 | actual-model | records carry actualModel when the CLI reports it … | 122.2 | 86.8 | −29% | each case needs a session per role, each a real worktree |
| #354 | merge-held | a PASSed PR failing test Y, which main does not fail: back to the implementer … | 118.7 | 74.8 | −37% | two impl + audit + ship rounds |
| #354 | size-check | no size session: a parent, a bug, a gate fix, a resumed worktree, sizeCheck false | 110.5 | 62.2 | −44% | five cases, each a run that must reach impl |
| #354 | stall | through the pool: a stalled issue is handed back as after a timed-out turn … | 108.3 | 70.7 | −35% | the stall and the timeout are real 1.2 s timers, and each has three turns and an exit-time health pass |
| #354 | audit | mergeRounds merge failures in a row: failed, the reason naming the merge rounds | 103.8 | 66.3 | −36% | two impl + audit + failed-merge rounds |
| #354 | session-setup | the audit's and the triage's notes come from their own worktree's setup | 102.9 | 78.0 | −24% | an impl, an audit and a triage, each with a real setup command |
| #354 | health | healthPass blocked after PASS: CONFLICTING, ship exit 3 and exit 4 → back to ready-for-agent … | 102.9 | 66.7 | −35% | three real ship runs (a conflict, a red test, a pass) |
| #354 | session-setup | worktreeSetup "" and no worktreeCopy: no setup line, no setup-* file, prompts as before | 94.8 | 75.0 | −21% | an issue and a triaged bug, each through impl, audit and merge |
| #354 | skills-run | roleSkills: {} → no skill sections, prompts byte-identical … | 94.1 | 76.9 | −18% | two full runs (roleSkills {} and empty lists), compared byte for byte |
| #354 | fleet-run | hx fleet run: every output line carries the [owner/name] prefix of its repo | 91.4 | 131.2 | +44% | not improved: two child `hx run` processes, each its own node with a full issue run. The doctor cut reaches them, but the run met more load |
| #354 | session-setup | a reused impl worktree: record ok → no setup run; record ok:false or missing → run again | 90.8 | 75.7 | −17% | two runs of three issues: a crash run, then the reuse |
| #354 | selfupdate | new code that exits on start: rolled back, the old runner keeps running … | 89.8 | 58.3 | −35% | real restarts of a copied install. A 3 s pause checks that nothing happens, and no event marks that |
| #354 | **sum of the 20** | | **2400.3** | **1695.0** | **−29%** | |

**Per file** (the 5 slowest files of the "before" profile; seconds of summed test time):

| PR | Test file | Tests | Before | After | Change |
|---|---|---|---|---|---|
| #354 | audit | 12 | 814.6 | 601.5 | −26% |
| #354 | release-cmd | 16 | 604.5 | 436.2 | −28% |
| #354 | selfupdate | 16 | 537.6 | 425.4 | −21% |
| #354 | session-setup | 8 | 512.3 | 383.5 | −25% |
| #354 | ship | 15 | 442.0 | 331.2 | −25% |

No cut is aimed at release-cmd or ship (`hx release` and `ship.mjs` run their own git and test commands). Their drop
matches the rest of the suite's: it comes from the load.
