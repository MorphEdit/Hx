Run every command in the foreground and wait for it. Never start a command in the background, and never poll for a background command's output in a loop.
When you run tests, run only the affected tests (the test files for the code you changed, the tests `rtdd which` names, any test file the issue names). Never run the full test command before shipping: ship.mjs runs it after the rebase. Run the full suite only after a ship.mjs exit 4, and then only once before shipping again. Give ship.mjs and the full test command a shell `timeout` of 3000000 ms (50 min): a shell command without its own timeout is stopped after 2 minutes.
Continue your task on {{SUBJECT}}. Check where it stands and do the next unfinished step. When it is genuinely complete, output exactly:
<promise>{{PROMISE}}</promise>
