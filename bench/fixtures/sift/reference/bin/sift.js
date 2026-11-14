#!/usr/bin/env node
// The sift command line: the arguments and environment to src/cli.js, its output to stdout and stderr, its exit code.
import { main } from '../src/cli.js';

const { code, stdout, stderr } = main(process.argv.slice(2), process.env);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = code;
