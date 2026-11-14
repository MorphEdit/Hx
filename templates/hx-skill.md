---
name: hx
description: Build something with hx — use when the user asks Claude Code to build a feature, app or change "with hx", to plan work for hx, or to file a PRD for hx's worker pool to build.
---

# hx

hx runs a pool of headless Claude Code workers that build a repository's GitHub issues. First you pick a
tier with the user. On the Direct path only, you build the change yourself, on a branch with a PR. Otherwise
you set the repository up, turn the user's idea into a PRD, file it, and get `hx run --watch` going so the
workers build it.

## 0. Pick the tier

Do this before anything else: no `hx doctor`, no `hx init`, no file written. Read the code you need (README,
CLAUDE.md, the source the idea touches) and ask the user just enough to estimate the size of the work.

{{TIERS}}

Then tell the user, in this order:
- the tier you pick: Direct, One child or Fleet;
- the reason, against the table above;
- a rough direct estimate and a rough fleet estimate, in minutes and dollars: the table's benchmark figures
  scaled by the size of this work. Say they are rough. When there is no data for this kind of work, say the
  estimate is a guess, and still offer the choice.

The user decides. An override in either direction is followed: Direct when you picked One child or Fleet, or
One child or Fleet when you picked Direct.

When the request is unattended (the user will not be around while it is built), do not offer Direct: the
choice is between One child and Fleet.

- **Direct:** follow "The Direct path" below, and skip steps 1–5.
- **One child or Fleet:** go on with step 1. Once the PRD is filed, One child versus Fleet is hx's own rule,
  not yours: a PRD with few acceptance criteria gets one child issue, a bigger one is decomposed. When the user
  wants the other one, name the settings that decide it (`singleChildMaxCriteria`, `workers`, `autoWorkers` in
  `.hx/config.json`), and do not edit `.hx/config.json` unless they ask.

## 1. Check the machine

Run `hx doctor`. If it reports a problem, relay each fix it prints to the user, word for word, and wait
until they say it is done; then run `hx doctor` again. Do not go on while it reports a problem.

Never run `gh auth login`, and never log in to GitHub, Claude or anything else for the user. If a login is
missing, tell the user the command to run themselves and wait.

## 2. Set the repository up

If `.hx/config.json` does not exist in the repository root, run `hx init`. Do not edit
`.hx/config.json` by hand unless the user asks.

## 3. Interview the user into a PRD

Before asking anything, read the code you need: README, CLAUDE.md, docs, and the source the idea touches.
Do not ask the user what the code can tell you. If the user has not said what they want to build, ask that
first.

Ask one question at a time — never a list of questions. Give each question your recommended answer, so
the user can just accept it. Keep asking until you know:
- the problem and goals;
- the scope and explicit non-goals;
- the user-facing behaviour;
- acceptance criteria a test can check;
- edge cases and error handling;
- constraints from the existing code.

Challenge vague answers instead of accepting them ("faster" — than what, measured how?). Stop when nothing
material is open; do not ask about details an implementer can decide.

## 4. Write and file the PRD

Write the PRD to a markdown file (for example `.hx/prds/<short-name>.md`) in this shape:

    # <title>
    ## Original request
    ## Goals
    ## Non-goals
    ## Behaviour
    ## Acceptance criteria
    ## Edge cases
    ## Notes for implementers

`## Original request` is the user's own words, word for word, as a block quote (every line starts with
`> `): first what they asked you to build, then each answer of theirs that changed or added scope, quoted as
they wrote it, in the order they gave them. No paraphrase and no summary. A later line outranks an earlier one.
The workers treat it as the last word: it outranks the rest of the PRD.

Sizing: keep one issue to about 30–45 min of work for one session; split anything bigger. Write the
PRD so the decomposer can cut it into issues of that size.

To have hx compare the result with a real product after the criteria pass, add an optional
`## Quality bar` section: `Beat: <named product> — <URL>`, then `Judged on:` with 2–4 dimensions as a list.

Show the user the finished PRD. When they confirm it, file it with `hx prd <file>`. Never create the issue
with `gh` yourself.

## 5. Start the workers

Tell the user to run `hx run --watch` in a terminal; it builds the PRD and keeps picking up new work. If
this host lets you start a long-running command in the background, you may start `hx run --watch` there
instead, and tell the user it is running and that `hx status` or `hx dashboard` shows its progress.

hx sets `HX_TEST_CONCURRENCY` (how many test files at once) for every session, gate run and merge it runs, so
the workers and the gate share the CPUs. It comes from the `testConcurrency` config key: `"auto"` by default, a
positive integer to fix it, `0` to leave it unset. If the user asks why tests run fewer files at once, point
them to that key.

## The Direct path

On Direct you do the work in this session. Run no `hx init`, write no PRD and run no `hx run`.

1. **Is hx running here?** Look for `.hx/config.json` in the repository root.
   - Not there: run no `hx` command at all (no `hx doctor`, no `hx init`) and no overlap check. Go to step 3.
   - There: go on with step 2.
2. **Overlap check, before changing anything.** Run `hx overlap <the files you expect to change>`.
   - Exit code 0 (`no overlap`): go on.
   - Exit code 1: do not make the change. File the work with `hx issue` instead, and tell the user which issue
     or PR overlaps (the output names them).
   - Exit code 2: tell the user the check failed, and do not commit.
3. **Make the change.** Branch from the base branch, make the change, and run the tests the change needs:
   `rtdd which` names them where the repository uses rtdd (`.rtdd/config.yaml`). Not the full suite.
4. **Overlap check again, before committing** (only where `.hx/config.json` exists). Run `hx overlap` with the
   files of `git diff --name-only <base branch>`. On exit code 1, do not commit or push: file the work with
   `hx issue`, and tell the user which issue or PR overlaps. On exit code 2, tell the user the check failed,
   and do not commit.
5. **Open a PR** whose body has the line `Direct fix: fits one session`, so history and the dashboard can tell
   it apart from fleet work. Merge it only once its checks pass and the user agrees.

## Rules

- Never run `gh auth login`, and never log in for the user.
- Commit, push and merge yourself only on the Direct path the user accepted. Never commit, push or merge work
  filed for the workers (a PRD, or an issue filed with `hx issue`): the workers build it.
