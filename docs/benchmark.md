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

Run it. Each run of an arm creates a private repo on your GitHub account and spends real usage, up to
the caps (`--max-hours` and `--max-usd`, 4 h and $60 per run by default):

```bash
node bench/project.mjs chat --runs 5    # 5 runs of the single session, each up to the caps
node bench/project.mjs hx3 --runs 5     # 5 runs of Hx with 3 workers, each up to the caps
node bench/project-review.mjs --all     # the blind review: 6 judge sessions per pair of runs
node bench/shiprule.mjs --baseline '<glob>' --change '<glob>'   # the ship rule: reads results only, no usage
node bench/figures.mjs                  # redraws the table below: no usage
```

- `--runs N` (default 1) runs the arm N times in a row under one stamp. Each run gets its own repo, its own
  caps and its own results file, `bench/results/project/<arm>-<stamp>-<i>.json` (i = 1…N). A run that fails
  is named at the end and the call exits 1; the other runs' files stay. The old
  `bench/results/project-<arm>.json` files still read, each as a single run.
- `project-review.mjs --all` pairs every run of `hx3` that has no review yet with the `chat` run of the same
  i in the newest `chat` set, and reviews each pair; a run with no such `chat` run is listed and skipped.
  `node bench/project-review.mjs <results-a> <results-b>` reviews one pair. A pair costs 6 judge sessions
  (3 judges, each in both orders), and each run is charged half.
- `shiprule.mjs` takes two globs of results files of the same arm, e.g.
  `'bench/results/project/hx3-202611100900-*.json'`. Quote them: the Windows shell does not expand a glob,
  and the script expands it itself. A glob may match the files of several `--runs` calls.
- `bench/figures.mjs` writes the table below from each arm's newest set (the call with the latest start).
  Do not edit the table by hand.

After the hidden tests, every run (done, capped or ended early) is fuzzed against the reference (`fuzz`,
`bench/project-fuzz.mjs` with its defaults: seed 1107, 1000 cases, 5 s per case) and then its own tests are
run under coverage (`coverage`, `bench/project-coverage.mjs`, 30 min limit), both on the same graded clone.
A fuzz or coverage run that throws never blocks the results file: its field is left out and the message is
recorded as `fuzzError` or `coverageError`.

**Same config for both arms.** Both arms and the judges run with Hx's lean flags (`--strict-mcp-config`,
`--disable-slash-commands`, `--setting-sources project,local`, `--tools`; the judges get only `Read`,
`Glob` and `Grep`), so none loads your own skills, plugins or MCP servers. Each run records what it ran
with under `provenance`: the Claude Code version, the Hx commit, and each role's model, effort and flags
(the judges' are in each review, as role `judge`). The notes under the table compare them: a field that
takes more than one value across the table's runs is named with each value and its runs. The Hx commit is
not compared, since a baseline and a change differ there by design. A run with no `provenance` (an old
file) is named as "config not recorded".

**What the columns measure:**
- **`n`:** how many runs the row is built from.
- **Hidden passed:** the hidden tests the run passed, out of all of them.
- **Fuzz divergences:** of 1000 generated `tally` command lines, each with a starting log and a clock, how
  many give a different result from the reference (standard output, whether standard error is empty, the
  exit status, or the log afterwards). The cases come from the brief only, each aimed at one of its edge
  cases (line endings, a byte order mark, a malformed clock, overlaps, rounding, CSV quoting and more). A
  case where the reference itself crashes is a generator bug: it is left out, never counted against the
  arm.
- **Fuzz classes:** how many distinct root causes those divergences have. A class is the edge case the
  case aimed at plus what differed first, e.g. `line-endings / log`. This is the main fuzz number: one bug
  the generator happens to hit 300 times is 300 divergences but one class, so the class count is not
  dominated by whichever bug the generator hits most often. It counts how many different things are wrong.
- **Blind review:** a score out of 10 from judge sessions that read the brief and both arms' code side by
  side, with every name of Hx, Claude, an arm or an author removed, labelled only A and B. Three judges
  score each copy on correctness, edge cases, error messages, clarity, tests and user documentation, once
  as A/B and once as B/A, so each copy gets 6 verdicts; the score is their mean. `–` until
  `project-review.mjs` has reviewed the run.
- **Coverage lines/branches:** the share of the arm's own source lines and branches (its test files left
  out) that its own `npm test` reaches, counted through every process the tests start. `n/a` when it has no
  tests or they fail.
- **Wall time, Tokens, Cost:** the run's, with its half of each blind review's tokens and cost.
- **Sessions, Issues closed/filed, Audit FAILs, Gate reds, Escaped defects, Capped:** what the run did, as
  before; Capped counts the runs that hit a cap.

**Why several runs.** One agent run varies 20–40% in time and cost from the next, so a single run supports
no claim: a row with `n` = 1 says "single run, supports no claim". With several runs, each cell shows the
median (the middle run; with an even count, the mean of the two middle ones) and, in brackets, the range:
the lowest and the highest run, e.g. `147 (145–149)/149`. The brackets are left out when every run has the
same value. A run without a value is left out of that cell.

**The ship rule** (`bench/shiprule.mjs`) says whether a change to Hx is safe to keep: whether a set of runs
made with the change is no worse than a set made before it. It passes only if all of these hold:
1. each set has at least 5 runs;
2. the change's median hidden-test pass count is no lower than the baseline's;
3. the change's median fuzz class count is no higher than the baseline's;
4. no new fuzz class: none appears in the change that never appeared in any baseline run;
5. the change's blind-review mean is at most 0.5 below the baseline's;
6. the change's median escaped defects are no higher than the baseline's.

With fewer than 5 runs in either set it prints "not enough runs" and how many each set is missing, runs no
other check and exits 2: not a FAIL, just no verdict yet. Otherwise it prints each check with its numbers
and PASS or FAIL, then the verdict: PASS exits 0, FAIL exits 1. A run without the value a check needs (an
old file, a run never reviewed) is left out of that check, and a check with no data in either set FAILs.
When the two sets' fuzz runs differ in seed, case count or generator, checks 3 and 4 FAIL as not
comparable. It also prints the change in median wall time, tokens and cost, as information only: a time
or cost win never makes a FAIL pass.

<!-- project-bench:start -->
| Arm | n | Hidden passed | Fuzz divergences | Fuzz classes | Blind review | Coverage lines/branches | Wall time | Tokens | Cost | Sessions | Issues closed/filed | Audit FAILs | Gate reds | Escaped defects | Capped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chat | 5 | 149/149 | 46 (28–62) | 6 (5–6) | 7.9 (7.7–8.1) | 98% (97%–99%)/45% (41%–48%) | 3.2 min (2.6 min–3.5 min) | 0.68M (0.62M–0.78M) | $1.82 ($1.60–$1.99) | 1 (chat 1) | 0/0 | – | – | 0 | 0 |
| hx3 | 5 | 149/149 | 64 (56–64) | 7 (5–7) | 7.5 (7.5–7.9) | 99% (99%–100%)/49% (44%–91%) | 26.3 min (23.3 min–28.3 min) | 4.32M (3.83M–5.14M) | $7.59 ($6.82–$7.86) | 19 (17–22) (critic 2, revise 2, decompose 1, impl 6, audit 6, review 1, security 1) | 5 (5–6)/5 (5–6) | 1 (0–2) | 0 | 0 | 0 |
<!-- project-bench:end -->

**Five runs per arm, 2026-11-08** (`claude-opus-5-5`, medium effort, both arms, Hx at 5f903ba, Claude Code
2.1.314, the lean flags on both arms). The table's cost includes each run's half of its blind-review pair
(about $1.10 a run).
- **Correctness:** both arms passed all 149 hidden tests in every run, with no escaped defect.
- **Fuzz:** neither arm is clean, and Hx is not better. The median is 6 root-cause classes for the single
  session and 7 for hx3. Four classes appear in all 10 runs of both arms (CSV quoting, dash-led arguments
  and a byte order mark changing the exit status, and unusual names and notes changing the log). A class
  that every build shares may come from the brief rather than from either arm, so those four are worth a
  look at the brief and the reference before they count against an arm.
- **Blind review:** the judges scored the single session higher in all 5 pairs: 7.9 against 7.5 (median,
  out of 10).
- **Own-test coverage:** about the same. Lines 98% against 99%, branches 45% against 49%.
- **Speed and cost:** the single session took a median 3.2 min and $0.68 before the review, and hx3 took
  26.3 min and $6.53. That is 8 times the time and 10 times the cost. The single session was much faster
  than in the first run (57 min); this benchmark does not show why.
- **Load:** both arms ran at the same time on the same 12-CPU machine, with Hx's own runner paused.

What this says: on a brief that fits one session, five runs agree with the first one. Hx costs about ten
times as much and improves no quality measure; the blind judges preferred the single session every time.
Hx's extra steps can only pay off on work that does not fit one session, which this benchmark does not
have yet.

**Experiment: one child up to 30 criteria, 2026-11-09/10** (same model, effort and Claude Code as the five
runs above; Hx at 0b9d8cf, with the gauntlet's acceptance-criteria check of #437, and the bench's
`--config singleChildMaxCriteria=30`). Results are in `bench/results/experiments/criteria30/project/`, out of
the table above and of `--all`. Each run was reviewed against the `chat` run of the same i from 2026-11-08.

```bash
node bench/project.mjs hx3 --runs 5 --config singleChildMaxCriteria=30
node bench/shiprule.mjs --baseline 'bench/results/project/hx3-202611081012-*.json' --change 'bench/results/experiments/criteria30/project/hx3-*.json'
```

- **Why 30:** the gauntlet now gives the brief an `## Acceptance criteria` section, but the reviser derived
  23 behaviours from it, above the default threshold of 15. One run at 15
  (`bench/results/experiments/criteria15/project/`) still decomposed into 5 issues, so the experiment raised
  the threshold to see what one child does on this brief.
- **The path:** all 5 runs took the one-child path: no decompose session, 2 issues (the PRD and its child),
  9 or 10 sessions instead of a median 19. Three of the five children needed a second implementer round
  after the audit.
- **Ship rule: FAIL**, on one check only. Hidden tests 149 → 149, fuzz classes (median) 7 → 6, blind
  review 7.60 → 7.66, escaped defects 0 → 0, all PASS. Check 4 FAILs: one fuzz class, `plain / exit status`,
  appears in run 2 (2 of 1000 cases) and in no baseline run. In both cases `tally start` gets no project
  and the log has a wrong line: the reference reports the usage error (exit 1), run 2 reads the log first
  and reports the log error (exit 2). The brief does not say which error wins, so the class is a gap in the
  brief as much as in the build, but the rule counts it.
- **Speed and cost (information only):** median wall time 26.3 → 16.3 min, cost with review halves $7.59 →
  $4.25, tokens 4.32M → 1.97M.

What this says: on this brief one child keeps the quality of the full fleet at a little over half the cost
and about 60% of the time, but by the ship rule it is not yet shown to be no worse. The default stays 15.

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

### Faster tests (2026-11-06 10:45)

PRD #348 stopped the test runs fighting over the CPU. The cutover is the merge of #350, the shared test-concurrency
budget. Later in the same batch:
- #351 and #352: reuse a tree that already passed its tests;
- #354 and #369: cut the slowest tests;
- #353: show the reused gate runs in `hx usage --compare`.

Measured on 2026-11-07 with `hx usage --compare "2026-11-06 10:45" --from "2026-11-05 13:19"`. "Before" starts at
the higher-effort cutover, so both sides run the same models and efforts. That is 14.9 h of runs before and 15.7 h
after:

| Board | Before | After |
|---|---|---|
| Issues closed | 27 (1.8 / h) | 21 (1.3 / h) |
| Tokens per closed issue | 6.2M | 4.3M |
| Cost per closed issue | $4.61 | $3.47 |
| Audit FAIL share | 10% | 13% |
| Gate runs reused | 0 | 11 |
| Median full gate run | 10m56s | 17m56s |
| Gate-fix issues per hour of runs | 0.20 | 0.06 |
| Sessions stopped: not mergeable | 2 | 0 |
| Rebase test retries | 2 | 0 |

**Reading it:**
- **Cheaper per issue:** 31% fewer tokens and 25% lower cost per closed issue.
- **Reuse works:** 11 gate runs reused a tree that had already passed. Each took seconds instead of a full run.
- **Fewer reds and merge stops:** one red gate (#359, a test that hit its timeout on a loaded machine). No
  unmergeable stops, and no rebase retries.
- **Fewer issues per hour:** most of the "after" board was chains, where each issue waited on the one before it.
  Often only one or two of the three workers had an issue they could take. Auto-scale also dropped to one worker
  once, when other projects' runners kept the CPU above 80%.
- **Full gate runs got slower:** the machine was busier. Other projects' runners shared it, at 44–85% CPU. The suite
  itself got faster: see "Test suite speed" below.
- **Small sample:** 21 issues after. The audit FAIL share (3 of 24) is within noise.
- **Escaped defects:** no reverts, no `bug` issues and no `security` issues were filed after the cutover. The PRD
  reviews of #348 and #367 found no gaps.


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
| #382 | 2026-11-06 | 3 | `3/3 (auto: cpu 67%)` | `3/3 (auto: cpu 77%)` | 114 s → 86 s (release-cmd and ship only) | 216.5 s → 169.9 s (−22%) |

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
| #382 | ship | ship: --test-timeout is remembered by --no-merge and reused by --resume; HX_SHIP_TEST_TIMEOUT_MS overrides it | 21.1 | 17.3 | −18% | two hung tests are killed at real timers, 6 s (the saved 0.1 min) and 7.2 s (HX_SHIP_TEST_TIMEOUT_MS): long enough for a loaded shell and node to write the pid first (#15) |
| #382 | ship | ship: a base that keeps moving is rebased and tested again 3 times, then exit 5 (#347) | 17.2 | 11.3 | −34% | four test runs, each a node that commits and pushes to main, and four rebase + push + refused-merge rounds: the rounds are the case |
| #382 | release-cmd | main moves after the head is read but before the gate checkout: the tag is on the sha the gate tested | 13.7 | 8.7 | −37% | HX_GIT_BIN is a node wrapper, so each of hx release's git calls is a node start too: the move must follow the ls-remote, and no git hook marks that call |
| #382 | release-cmd | hx release --yes: package.json bumped and committed on main, annotated tag on it, release with the notes; minor with a closed PRD; then nothing to release | 12.4 | 26.5 | +114% | not improved: the file's first test also builds the template repos (about 2 s), and this run met a load spike (ship's first test spiked at the same moment). Alone it takes 8.4 s; in the second pair 8.5 → 10.5 s |
| #382 | release-cmd | main moves after the gate checked it out: the tag is on the sha the gate tested, never the newer head | 10.2 | 5.3 | −48% | gate.mjs stays a node: it pushes the commit that moves main during the gate |
| #382 | ship | ship: a test run past --test-timeout is killed with its whole tree and fails like a failing test | 9.5 | 7.8 | −18% | the hung test is killed at a real 6 s timer (0.1 min), long enough for a loaded shell and node to write its pid first (#15) |
| #382 | release-cmd | an origin hook rejecting the branch push: the tag goes on G alone, the release is made, no release commit on main | 9.2 | 4.6 | −50% | a real hook refuses a real atomic push, then the tag is pushed on G |
| #382 | release-cmd | an explicit bump overrides the default; a prompt answered with anything but y/yes changes nothing | 9.1 | 4.9 | −46% | three hx runs (no, yes, a bad bump), one of them a full release |
| #382 | release-cmd | red gate → exit 1 with its output, no tag, no release; no gate command → exit 1, no tag, no release | 9.0 | 3.9 | −56% | two fixtures and two hx runs, one with a real gate worktree |
| #382 | release-cmd | --dry-run: prints the plan and the recorded gate result, never runs the gate, changes nothing; also while a run is live | 8.4 | 2.5 | −70% | two hx runs, each a fetch of origin's tags and an ls-remote |
| #382 | release-cmd | hx release --yes with no closed PRD: a patch bump; with no package.json the tag goes on the gated head itself | 8.3 | 6.6 | −21% | the first test without package.json: it builds that template; then a release with a gate worktree and a release worktree |
| #382 | ship | ship: a commit lands on the base between the rebase and the merge: rebased, tested and merged again, exit 0 (#347) | 8.2 | 4.7 | −42% | two test runs and two rebase + push + merge rounds |
| #382 | ship | ship: a merge limited twice (secondary, Retry-After: 1) waits, retries and ships, one stderr line per wait | 7.5 | 4.7 | −37% | the 1 s and 2 s rate-limit waits are real: the test checks they were slept (≥ 3 s) |
| #382 | release-cmd | the recorded gate result for the head is used (no gate run); a red one stops the release | 7.3 | 3.7 | −50% | two hx runs, one a full release |
| #382 | release-cmd | a gate run by hx release leaves gate.json unchanged (the learned command is used) | 7.2 | 3.7 | −49% | a full release with a gate run |
| #382 | ship | ship: a merge that keeps failing with the head up to date with the base exits 5 without rebasing again (#347) | 5.6 | 3.1 | −45% | five refused merges, each followed by a real fetch of the base to see whether it moved |
| #382 | release-cmd | the last tag on origin has no release: only that release is made (no gate, no tag); run again → nothing to release | 5.5 | 4.3 | −22% | two hx runs, after a tag push to origin |
| #382 | release-cmd | no tag: the version comes from package.json and the notes link the commits | 5.5 | 4.5 | −18% | a full release with a gate run and a release worktree |
| #382 | ship | ship: commits, rebases, tests, pushes, opens + merges the PR, deletes the branch, closes the issue | 5.4 | 23.5 | +332% | not improved: the file's first test also builds the template repos (about 1 s), and this run met the same load spike as release-cmd's first test. Alone it takes 4.5 s; in the second pair 3.9 → 4.8 s |
| #382 | ship | ship: limited past HX_GH_WAIT_MAX_SECONDS fails with exit 5 and the reset time, without waiting past the cap | 4.7 | 2.4 | −49% | a real 1 s wait before the call that gives up |
| #382 | **sum of the 20** | | **185.0** | **154.0** | **−17%** | |

**Per file** (the 5 slowest files of the "before" profile; seconds of summed test time):

| PR | Test file | Tests | Before | After | Change |
|---|---|---|---|---|---|
| #354 | audit | 12 | 814.6 | 601.5 | −26% |
| #354 | release-cmd | 16 | 604.5 | 436.2 | −28% |
| #354 | selfupdate | 16 | 537.6 | 425.4 | −21% |
| #354 | session-setup | 8 | 512.3 | 383.5 | −25% |
| #354 | ship | 15 | 442.0 | 331.2 | −25% |
| #382 | release-cmd | 16 | 113.5 | 84.8 | −25% |
| #382 | ship | 15 | 102.9 | 85.1 | −17% |

No cut is aimed at release-cmd or ship (`hx release` and `ship.mjs` run their own git and test commands). Their drop
matches the rest of the suite's: it comes from the load.
Cutting release-cmd and ship themselves is not in #354: release-cmd and ship are left to #369, the child issue
filed when #354 was narrowed, which adds its own rows here.

**#382 (#369): what changed in release-cmd and ship.** Both profiles ran only these two files, with the
`test:profile` reporters and `--test-concurrency=3` (`node --test --disable-warning=ExperimentalWarning
--test-concurrency=3 --test-reporter=spec --test-reporter-destination=<file> --test-reporter=./test/profile-reporter.mjs
--test-reporter-destination=stdout test/release-cmd.test.ts test/ship.test.ts`: the script's glob is fixed, and
`npm run test:profile -- <files>` would run the whole suite as well). The cuts:
- each file builds its git repos once (`test/repo-copy.ts`: release-cmd one set per shape, with or without
  package.json and the tag) and copies them for each test, then points the copied clones at the copy's own origin.
  A copy is file I/O. The init, the two clones, the commit, the tag and the push it replaces were seven git commands,
  plus the upload-pack and receive-pack each clone and push starts;
- release-cmd's commits are pushed once per test, not once per commit;
- release-cmd's gate is the shell line `git rev-parse HEAD >> "<runs>"` (`&& exit 1` for the red gate), so a gate
  run starts no node; only the test that moves main during the gate keeps gate.mjs. ship's passing test command is
  `exit 0` and its failing one `echo boom&& exit 1`, not a node start each;
- ship's landing script no longer pulls before it commits: its clone is the only one that pushes main;
- `hx release` makes two git calls fewer: `git commit -- package.json` without a `git add` first, and
  `git tag -f -a` in place of `git tag -d` and `git tag -a`.

No back-off was reached that needed a new override: `HX_SHIP_RETRY_MS` is already 10 ms in the three ship tests that
retry a merge; the 5 s pipe timer after a timed-out test is not reached (the hung test's tree is killed with its
pipes); `HX_PR_RETRY_MS` and `HX_LABEL_RETRY_MS` are in `src/pool.ts`, which neither file runs.

The sum fell 22% (the top 20: 17%), short of the 40% aimed at. Most of what is left is waited for on purpose: the
6 s, 6 s and 7.2 s test timeouts and the 1 s, 2 s and 1 s rate-limit waits are about 23 s of the 170 s. The rest is
real work each test checks: every `hx release` runs about 35 git commands (two worktrees, fetches, the tag and push),
and every `ship.mjs` a commit, a fetch, a rebase and a push. The first test of each file also builds its template
repos, so those two tests are no faster. A second pair, run right after the first (`workers` `3/3 (auto: cpu 82%)`
and `3/3 (auto: cpu 85%)`), gave 180.7 s → 138.7 s (−23%): release-cmd 93.6 → 71.9 s, ship 87.2 → 66.8 s.
