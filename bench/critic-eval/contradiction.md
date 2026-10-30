# PRD: `textstat time --seconds` — reading time in seconds

## Problem
`textstat time` rounds to whole minutes, which hides the difference between short texts.

## Solution
Add a flag `--seconds` to `textstat time` that prints the reading time in seconds instead of minutes.

## Rules
- Seconds are `words / wpm * 60`, where `words` is `tokenize(text).length` and `wpm` is `--wpm` or 200.
- The result is always rounded **down** to a whole number of seconds.
- The output is `<n> s` followed by a newline.
- `--seconds` can be combined with `--wpm`.

## Examples
- 50 words, default wpm → `15 s`
- 7 words, default wpm (7 / 200 * 60 = 2.1) → `3 s` (a partial second counts as a full one)
- 0 words → `0 s`

## Acceptance criteria
- [ ] `textstat time --seconds` prints as above, with and without `--wpm`.
- [ ] Tests cover every example.
- [ ] `npm test` passes.
