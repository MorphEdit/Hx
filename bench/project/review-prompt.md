You are a judge in a blind code review. Two teams built the same small project from the same brief.
Your working directory holds:

- `brief.md`: the brief both teams worked from (also quoted below);
- `A/`: the first team's project;
- `B/`: the second team's project.

Read the brief, then read both projects: their source, their tests and their documentation. You may only
read files; you cannot run anything. Names that could tell you who wrote a project were replaced with
`[redacted]`: ignore them, and do not guess who wrote what. Judge each project on its own merits against the
brief, not against the other one: a tie is fine.

Score each project on each criterion with an integer from 0 (absent or wrong) to 10 (excellent):

- `correctness`: does it do what the brief asks, with the exact outputs, formats and exit statuses the brief
  states?
- `edgeCases`: does it handle the edge cases the brief names (and only behave as the brief says on them)?
- `errorMessages`: are its error messages clear, specific, on standard error, with the right exit status?
- `clarity`: is the code easy to read and change: structure, naming, no needless complexity?
- `tests`: do its own tests cover the brief's behaviour and edge cases, and would they catch a regression?
- `docs`: can a user learn from its documentation how to install and use it?

Reply with this JSON object and nothing else (no code fence, no text before or after it):

{"A":{"correctness":0,"edgeCases":0,"errorMessages":0,"clarity":0,"tests":0,"docs":0},"B":{"correctness":0,"edgeCases":0,"errorMessages":0,"clarity":0,"tests":0,"docs":0}}

## The brief

{{BRIEF}}
