// The errors ledge reports. Each kind carries the exit code the brief gives it, so the command line can turn any of
// them into a message on stderr and an exit code without knowing where it came from.
//
// The order of the list in the brief is the order the command line checks things in:
//   1 usage, 2 environment, 3 the journal, 4 the other input files, 5 the command's own checks.

/** The exit codes, by kind. */
export const EXIT = {
  ok: 0,
  usage: 1,
  environment: 2,
  journal: 3,
  input: 4,
  command: 5,
};

/** Every error ledge reports on purpose: a message and an exit code. */
export class LedgeError extends Error {
  /**
   * @param {string} message the text printed on stderr
   * @param {number} code the exit code
   */
  constructor(message, code) {
    super(message);
    this.name = 'LedgeError';
    this.code = code;
  }
}

/** A malformed command line: exit 1. */
export class UsageError extends LedgeError {
  constructor(message) {
    super(message, EXIT.usage);
    this.name = 'UsageError';
  }
}

/** A bad LEDGE_TODAY, or a file named on the command line that cannot be read: exit 2. */
export class EnvironmentError extends LedgeError {
  constructor(message) {
    super(message, EXIT.environment);
    this.name = 'EnvironmentError';
  }
}

/**
 * An error at one line of a file: the journal (exit 3) or another input file (exit 4). The message names the file and
 * holds `line N`; the `line` property is N and `file` the name used in the message.
 */
export class LineError extends LedgeError {
  /**
   * @param {string} file the file's name as shown to the user
   * @param {number} line the line number, counting from 1
   * @param {string} what what is wrong
   * @param {number} code the exit code
   */
  constructor(file, line, what, code) {
    super(`${file} line ${line}: ${what}`, code);
    this.name = 'LineError';
    this.file = file;
    this.line = line;
    this.what = what;
  }
}

/** An error in the journal or a file it includes: exit 3. */
export class JournalError extends LineError {
  constructor(file, line, what) {
    super(file, line, what, EXIT.journal);
    this.name = 'JournalError';
  }
}

/** An error in the content of the CSV, rules or budget file: exit 4. */
export class InputError extends LineError {
  constructor(file, line, what) {
    super(file, line, what, EXIT.input);
    this.name = 'InputError';
  }
}

/** A check of the command against the journal that fails: exit 5. */
export class CommandError extends LedgeError {
  constructor(message) {
    super(message, EXIT.command);
    this.name = 'CommandError';
  }
}
