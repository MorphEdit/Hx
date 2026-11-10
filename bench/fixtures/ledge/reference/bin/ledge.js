#!/usr/bin/env node
// The ledge command line: the arguments and environment to src/cli.js, its output to stdout and stderr, its exit code.
import { run } from '../src/cli.js';

const { code, stdout, stderr } = run(process.argv.slice(2), process.env);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
