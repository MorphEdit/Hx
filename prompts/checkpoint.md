HX CHECKPOINT — the run is being stopped. Stop the current work right now and hand it over to the
next session, which starts fresh and only sees what you leave in git and on the issue:

1. Commit everything in the worktree, even if it is broken: `git add -A && git commit -m "wip: checkpoint (#{{ISSUE}})"` (skip if nothing changed).
2. Push the branch: `git push -u origin {{BRANCH}}`. Do NOT open, merge or close anything.
3. Post one comment on #{{ISSUE}} whose FIRST line is `<!-- hx-handoff -->`, then, tersely:
   what is done, what is left, the exact next step, and anything the next session must know
   (failing tests, decisions made, traps). Use `gh issue comment {{ISSUE}} -R {{REPO}} --body-file <file>`.

Run every command in the foreground and wait for it. Never start a command in the background, and never poll for a background command's output in a loop.

Then output exactly:
<promise>CHECKPOINT {{ISSUE}} DONE</promise>
