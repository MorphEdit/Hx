---
name: hx
description: Build something with hx — use when the user asks Claude Code to build a feature, app or change "with hx", to plan work for hx, or to file a PRD for hx's worker pool to build.
---

# hx

hx runs a pool of headless Claude Code workers that build a repository's GitHub issues. You do not build
the feature yourself: you set the repository up, turn the user's idea into a PRD, file it, and get
`hx run --watch` going so the workers build it.

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
    ## Goals
    ## Non-goals
    ## Behaviour
    ## Acceptance criteria
    ## Edge cases
    ## Notes for implementers

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

## Rules

- Never run `gh auth login`, and never log in for the user.
- Never commit, push or merge the feature yourself: the workers build it from the PRD.
