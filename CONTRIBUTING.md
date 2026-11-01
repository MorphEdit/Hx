# Contributing to Hx

Thanks for helping. Hx is built mostly by Hx itself: work is filed as GitHub issues and PRDs, and
`hx run --watch` on this repo builds, audits and merges it. Human pull requests are welcome too, and
follow the same rules.

## Setup

- Node ≥ 23.6 (Hx runs its TypeScript directly; there is no build step and no dependency to install)
- git and the GitHub CLI (`gh`), logged in
- Claude Code (`claude`) only for real runs; the tests never start it

```bash
git clone https://github.com/MorphEdit/Hx.git
cd Hx
npm link        # puts `hx` on PATH
npm test
```

Read [CLAUDE.md](CLAUDE.md) (where things are, conventions) and [docs/design.md](docs/design.md)
(why Hx is built this way) before a larger change.

## Proposing work

| What | How |
|---|---|
| A bug | `hx bug "what happens, what you expected"`, or an issue with the `bug` label. Hx triages it (reproduces it and writes a failing test) before anyone fixes it. |
| A small change (one issue) | `hx issue "idea"`: a short interview that files one issue with acceptance criteria. |
| A feature | `hx grill "idea"`: an interview that writes a PRD (`prd` label). Hx's gauntlet critiques it, then splits it into issues. |

An issue needs testable acceptance criteria and a `## Blocked by` section (`None`, or `#N` /
`owner/repo#N`). Hx only claims issues opened by trusted accounts, so issues from other accounts are
read by the maintainer first.

## Making a change by hand

1. Branch from `main` (`issue/<n>` when there is an issue).
2. Write a test that fails without your change. End-to-end tests use real git with a local bare
   origin and the fakes in `test/fakes/`; never the real board, the real `~/.hx` or a real `claude`.
3. `npm test` must pass. Never push with a failing test.
4. Commit messages follow Conventional Commits and close the issue:
   `fix: <what changed> (closes #N)`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.
5. Open a pull request against `main`. Keep it to one issue.

### Rules that are easy to miss

- Everything in the repo is English: code, comments, docs, commit messages.
- Spawn processes without a shell and pass prompts and bodies through stdin (Windows quoting).
- Agents read issues only through `scripts/issue.mjs`, never `gh issue view --comments`. Anything that
  lets text from GitHub reach a prompt is a security question first: workers run with
  bypassPermissions.
- Role prompts keep the foreground-only rule: never start a command in the background or poll for one.
- A change that can affect quality or tokens (prompts, roles, models, the merge path) is re-measured
  with the benchmark (`bench/`), and the README numbers are regenerated, never edited by hand. The
  benchmark creates private GitHub repos and spends real usage: the maintainer runs it.

## Releases

Hx uses [semantic versioning](https://semver.org). While the version is `0.x`, a minor bump may
change behaviour or config.

1. `main` is green (`npm test`, and the CI gate in `hx status`).
2. Set `version` in `package.json` and commit it: `chore: release vX.Y.Z`.
3. Tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push origin vX.Y.Z`.
4. Publish the GitHub release with notes grouped by feature, fix and docs, naming the PRDs and issues:
   `gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes.md>`.

Install a specific release with `git checkout vX.Y.Z` and `npm link` in the clone.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
