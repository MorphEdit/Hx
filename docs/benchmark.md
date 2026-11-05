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

`bench/figures.mjs` writes the table below from `bench/results/project-*.json`. It is empty until a
real run is committed.

<!-- project-bench:start --><!-- project-bench:end -->

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

