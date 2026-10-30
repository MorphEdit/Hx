# PRD: `freq --min` — hide short words

## Problem
`textstat freq` output is dominated by short words like "a", "to" and "of".

## Solution
Add an option `--min N` to `textstat freq` that leaves out short words, so only the longer, more
interesting words are listed. It works together with `--top`.

## Rules
- `--min N` takes a positive integer; anything else prints `USAGE` to stderr and exits 1.
- Without `--min`, the output is unchanged.
- Short words are dropped from the output.

## Examples
- a file containing `a big elephant`, `textstat freq --min 4 file` → lists only `elephant 1`
- `textstat freq --min 0 file` → usage on stderr, exit 1

## Acceptance criteria
- [ ] `textstat freq --min N` drops short words as described.
- [ ] Tests cover the examples.
- [ ] `npm test` passes.
