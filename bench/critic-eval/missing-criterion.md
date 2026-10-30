# PRD: `textstat freq --json` — machine-readable output

## Problem
Scripts that use `textstat freq` have to parse `word count` lines.

## Solution
Add a flag `--json` to `textstat freq`. With it the output is a single JSON array of
`{"word": <string>, "count": <number>}` objects, in the same order as the text output, followed by a newline.

## Rules
- `--json` works together with `--top N`.
- Without `--json` the output is unchanged.
- When the input file has no words, the output is an empty array `[]`.
- A file that cannot be read prints the error as JSON, `{"error": <message>}`, to stdout instead of stderr.

## Examples
- a file containing `b a b` → `[{"word":"b","count":2},{"word":"a","count":1}]`
- `--json --top 1` on the same file → `[{"word":"b","count":2}]`

## Acceptance criteria
- [ ] `textstat freq --json` prints the array above, with and without `--top`.
- [ ] An empty file prints `[]`.
- [ ] Tests cover the examples.
- [ ] `npm test` passes.
