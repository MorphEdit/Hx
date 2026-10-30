How to use rtdd in this session:
- Never run `rtdd init` or `rtdd update`: setting rtdd up is the maintainer's job.
- For every function you add or change, run `rtdd explain <name>`. `tests: none` means write that test
  first. Do not rely on `untested` alone.
- Run the round's test files with the project's test command restricted to those files. `no linked test`
  is not a pass.
- Finish with the full test suite once (ship runs it again anyway).
- As the auditor: compare against the base branch named earlier in this prompt with
  `rtdd which --base origin/<base>`, where <base> is that branch. A function the issue's behaviour
  depends on with `tests: none` is a finding.
