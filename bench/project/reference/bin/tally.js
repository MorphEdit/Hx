#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dayReport, duration, findOverlaps, formatDay, formatDuration, formatEntry, formatProjects, formatWeek,
  isDate, isProject, isTime, parseLog, projectReport, toCsv, toMinutes, weekReport,
} from '../src/tally.js';

class Fail extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const USAGE = 'usage: tally start <project> [note] | stop | status | add <project> <from> <to> [note]'
  + ' | report day|week [YYYY-MM-DD] | report project | overlaps | csv';

function now() {
  const v = process.env.TALLY_NOW;
  if (v === undefined || v === '') {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  if (!isTime(v)) throw new Fail(`TALLY_NOW is not a YYYY-MM-DDTHH:MM time: ${v}`);
  return v;
}

const logPath = () => process.env.TALLY_LOG || path.join(os.homedir(), '.tally.log');

function load() {
  const file = logPath();
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let entries;
  try {
    entries = parseLog(text);
  } catch (e) {
    throw new Fail(`${file}: ${e.message}`, 2);
  }
  return { file, text, entries };
}

function append(file, text, line) {
  const base = text === '' || text.endsWith('\n') ? text : text + '\n';
  writeFileSync(file, base + line + '\n');
}

function run(args) {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case 'start': {
      const [project, ...note] = rest;
      if (!isProject(project)) throw new Fail(`start needs a valid project name\n${USAGE}`);
      const t = now();
      const { file, text, entries } = load();
      const running = entries.find((e) => !e.end);
      if (running) throw new Fail(`already running: ${running.project} since ${running.start}`);
      append(file, text, formatEntry({ start: t, end: null, project, note: note.join(' ') }));
      return `started ${project} at ${t}`;
    }
    case 'stop': {
      const t = now();
      const { file, text, entries } = load();
      const running = entries.find((e) => !e.end);
      if (!running) throw new Fail('not running');
      if (toMinutes(t) <= toMinutes(running.start)) throw new Fail(`now (${t}) is not after the start (${running.start})`);
      const done = { ...running, end: t };
      const lines = text.split('\n');
      lines[running.line - 1] = formatEntry(done) + (lines[running.line - 1].endsWith('\r') ? '\r' : '');
      let out = lines.join('\n');
      if (!out.endsWith('\n')) out += '\n';
      writeFileSync(file, out);
      return `stopped ${running.project} at ${t} (${formatDuration(duration(done))})`;
    }
    case 'status': {
      const t = now();
      const running = load().entries.find((e) => !e.end);
      return running ? `${running.project} running since ${running.start} (${formatDuration(duration(running, t))})` : 'not running';
    }
    case 'add': {
      const [project, from, to, ...note] = rest;
      if (!isProject(project)) throw new Fail(`add needs a valid project name\n${USAGE}`);
      if (!isTime(from) || !isTime(to)) throw new Fail('add needs two YYYY-MM-DDTHH:MM times');
      if (toMinutes(to) <= toMinutes(from)) throw new Fail(`${to} is not after ${from}`);
      const { file, text } = load();
      const e = { start: from, end: to, project, note: note.join(' ') };
      append(file, text, formatEntry(e));
      return `added ${project} ${from} to ${to} (${formatDuration(duration(e))})`;
    }
    case 'report': {
      const [kind, date, extra] = rest;
      if (extra !== undefined) throw new Fail(USAGE);
      const t = now();
      if (kind === 'project') {
        if (date !== undefined) throw new Fail(USAGE);
        return formatProjects(projectReport(load().entries, t));
      }
      if (kind !== 'day' && kind !== 'week') throw new Fail(USAGE);
      if (date !== undefined && !isDate(date)) throw new Fail(`not a YYYY-MM-DD date: ${date}`);
      const d = date ?? t.slice(0, 10);
      const { entries } = load();
      return kind === 'day' ? formatDay(dayReport(entries, d, t)) : formatWeek(weekReport(entries, d, t));
    }
    case 'overlaps': {
      const t = now();
      const pairs = findOverlaps(load().entries, t);
      return pairs.length ? pairs.map(([a, b]) => `line ${a} overlaps line ${b}`).join('\n') : 'no overlaps';
    }
    case 'csv':
      return toCsv(load().entries).replace(/\n$/, '');
    default:
      throw new Fail(USAGE);
  }
}

try {
  process.stdout.write(run(process.argv.slice(2)) + '\n');
} catch (e) {
  process.stderr.write(`tally: ${e.message}\n`);
  process.exitCode = e instanceof Fail ? e.code : 1;
}
