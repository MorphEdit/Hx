# PRD: `textstat words` — count the words in a file

## Problem
Users want the number of words in a file without piping `freq` through other tools.

## Solution
A new subcommand `textstat words <file>` prints the number of words in the file, as counted by
`tokenize()` in `src/tokenize.js` (the same words `freq` counts), followed by a newline. Nothing else is printed.

## Rules
- The count is `tokenize(text).length` — no other splitting or filtering.
- An empty file, or a file with no words, prints `0`.
- A missing file argument prints the existing `USAGE` string (extended with `| words <file>`) to stderr
  and exits 1, like the other subcommands.
- A file that cannot be read prints the error message to stderr and exits 2, like `freq` and `time`.

## Examples
- a file containing `Hello, hello world` → stdout `3\n`, exit 0
- an empty file → stdout `0\n`, exit 0
- `textstat words` → usage on stderr, exit 1
- `textstat words missing.txt` → error on stderr, exit 2

## Acceptance criteria
- [ ] `bin/textstat.js` handles `words` as above; `USAGE` lists it.
- [ ] Tests in `test/words.test.js` cover every example above by running the CLI with `node`.
- [ ] `npm test` passes.
