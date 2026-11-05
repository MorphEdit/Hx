# tally

I want a small Node tool, `tally`, to track the time I spend on projects: a command-line program and a
library I can import. No dependencies. Everything lives in one plain-text log I can open and fix by hand.

## Time and the log file
- Times are written `YYYY-MM-DDTHH:MM`, e.g. `2024-03-04T09:15`. No seconds, no time zone: tally never
  converts zones, and every time is taken as written.
- "Now" is the `TALLY_NOW` environment variable (same format, e.g. `TALLY_NOW=2024-03-04T09:15`). If it
  is not set, use the computer's local clock. If it is set but malformed, that is an error.
- The log is the file named by the `TALLY_LOG` environment variable; without it, `.tally.log` in my home
  folder. A log that does not exist yet is an empty log.

## The log format
One entry per line: start, end, project, then an optional note, separated by spaces:

    2024-03-04T09:00 2024-03-04T10:15 acme fixed the login bug
    2024-03-04T13:00 - beta

- The end is `-` while the entry is still running. At most one entry can be running.
- A project name is letters, digits, `-`, `_` and `.`, starting with a letter or digit (`acme`,
  `client-2.web`).
- The note is the rest of the line (it may contain spaces). No note is fine.
- When I edit by hand I may use several spaces or tabs between fields, leave blank lines, end lines with
  CRLF, and add comment lines starting with `#`. All of that is read fine and left as it is.
- When tally writes an entry it uses single spaces and no trailing space, e.g.
  `2024-03-04T09:00 2024-03-04T10:15 acme fixed the login bug`. New entries are appended at the end of
  the file; stopping rewrites only the running entry's line, in place. The file always ends with a newline
  after tally writes it.

## Strict reading
The log is read strictly. A line is wrong when: it has fewer than three fields; a time is malformed or not
a real date or time (`2024-02-30T10:00`, `2024-03-04T24:00`); the project name is invalid; the end is not
after the start; or it is a second running entry. Any wrong line is an error that names its line number
(counting every line of the file from 1, blank and comment lines included), e.g. `line 3: end is before start`.
The exact wording is up to you, but the message must contain `line N`. With several wrong lines, the
first one is reported.

## Commands
Output goes to stdout. Errors go to stderr only, never stdout. Exit codes: `0` success; `1` a usage or
state error (unknown command, missing or bad argument, bad `TALLY_NOW`, already running, not running);
`2` the log cannot be read (the message names the line). On any error the log is left untouched.
Durations are shown as `h:mm`: 75 minutes is `1:15`, 600 is `10:00`, 0 is `0:00`.

- `tally start <project> [note]` starts an entry at now. Every word after the project is the note
  (`tally start acme fix the login` has the note `fix the login`). Prints `started acme at 2024-03-04T09:15`.
  If something is already running: exit 1, and the message names the running project.
- `tally stop` ends the running entry at now. Prints `stopped acme at 2024-03-04T10:30 (1:15)`. Nothing
  running, or now not after its start: exit 1.
- `tally status` prints `acme running since 2024-03-04T09:15 (1:15)` (the time so far, not rounded), or
  `not running`. Both exit 0.
- `tally add <project> <from> <to> [note]` records a finished entry, e.g. `tally add acme
  2024-03-04T09:00 2024-03-04T10:00 standup`. Prints `added acme 2024-03-04T09:00 to 2024-03-04T10:00 (1:00)`.
  A bad time, or `<to>` not after `<from>`: exit 1.
- `tally report day [YYYY-MM-DD]` (default: the day of now), `tally report week [YYYY-MM-DD]` (the
  Monday-to-Sunday week holding that day, default now's week) and `tally report project` (all time).
- `tally overlaps` lists entries whose times overlap, one pair per line by line number, smaller first, pairs
  in order: `line 3 overlaps line 5`. Touching (one ends when the next starts) is not an overlap. With none
  it prints `no overlaps`. Exit 0 either way.
- `tally csv` prints every finished entry, in log order, as CSV (the running entry is left out).

## Reports and rounding
A running entry counts up to now. An entry that crosses midnight counts on each day for the part on that
day. Each report row is rounded on its own to the nearest quarter hour: 7 minutes past a quarter or less
rounds down, 8 or more rounds up (1:07 → 1:00, 1:08 → 1:15, 0:05 → 0:00). The total is the sum of the
rounded rows. Projects sort by name, days by date; a row that rounds to `0:00` is still shown; a day or
project with no time at all is not.

    $ tally report day 2024-03-04      $ tally report week 2024-03-06      $ tally report project
    2024-03-04                         week of 2024-03-04                  acme 12:30
    acme 1:15                          2024-03-04 1:45                     beta 3:15
    beta 0:30                          2024-03-06 0:15                     total 15:45
    total 1:45                         total 2:00

The day report starts with the date, the week report with `week of` and that week's Monday. With no time
at all a report is just its header (if any) and `total 0:00`.

## CSV
Header row `project,start,end,minutes,note`, then one row per entry; `minutes` is the exact, unrounded
duration. A field that contains a comma or a double quote is wrapped in double quotes, with each double
quote inside doubled; other fields are written as they are. Every row ends with `\n`.

    project,start,end,minutes,note
    acme,2024-03-04T09:00,2024-03-04T10:15,75,"fixed login, again"
    beta,2024-03-04T13:00,2024-03-04T13:20,20,

## Using it from Node
Importing the package gives these functions. An entry is `{ line, project, start, end, note }`: `line` is
its line number in the text, `start`/`end` are time strings, `end` is `null` while running, and `note` is
`''` when there is none. `now` and dates are strings in the formats above.

- `parseLog(text)` → the entries in file order. On a wrong line it throws an `Error` whose message
  contains `line N` and whose `line` property is N.
- `formatEntry(entry)` → that entry's log line, without a newline.
- `duration(entry, now)` → whole minutes (a running entry up to now).
- `roundMinutes(minutes)` → rounded to the nearest quarter hour, as above.
- `formatDuration(minutes)` → the `h:mm` text.
- `dayReport(entries, date, now)` → `{ date, rows: [{ project, minutes }], total }`.
- `weekReport(entries, date, now)` → `{ start, rows: [{ date, minutes }], total }` (`start` is the Monday).
- `projectReport(entries, now)` → `{ rows: [{ project, minutes }], total }`.
- `findOverlaps(entries, now)` → `[[lineA, lineB], …]`, as `tally overlaps` lists them.
- `toCsv(entries)` → the CSV text, as `tally csv` prints it.

Report minutes are the rounded ones, and rows are in the same order as the printed report.
