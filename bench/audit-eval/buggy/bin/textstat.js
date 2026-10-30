#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { wordFreq } from '../src/freq.js';
import { slugify } from '../src/slugify.js';
import { readingTime } from '../src/reading.js';

const USAGE = 'usage: textstat freq [--top N] <file> | slug <text...> | time [--wpm N] <file>';
const fail = (msg, code) => { process.stderr.write(msg + '\n'); process.exit(code); };

function opt(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  if (!(v > 0)) fail(USAGE, 1);
  args.splice(i, 2);
  return v;
}

function read(file) {
  if (!file) fail(USAGE, 1);
  try { return readFileSync(file, 'utf8'); } catch (e) { fail(String(e.message), 1); }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'freq') {
  const top = opt(args, '--top');
  for (const [w, n] of wordFreq(read(args[0]), { top })) process.stdout.write(`${w} ${n}\n`);
} else if (cmd === 'slug') {
  if (!args.length) fail(USAGE, 1);
  process.stdout.write(slugify(args.join(' ')) + '\n');
} else if (cmd === 'time') {
  const wpm = opt(args, '--wpm');
  process.stdout.write(`${readingTime(read(args[0]), wpm)} min\n`);
} else {
  fail(USAGE, 1);
}
