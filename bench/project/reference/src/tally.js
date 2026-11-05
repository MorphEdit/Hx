// tally: the library. Times are naive `YYYY-MM-DDTHH:MM` strings; arithmetic goes through UTC so no
// time zone or daylight saving change ever moves them.

const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DAY_MS = 86_400_000;

export function isTime(s) {
  const m = TIME.exec(s ?? '');
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && isTime(`${s}T00:00`);
export const isProject = (s) => PROJECT.test(s ?? '');

/** minutes since the epoch */
export function toMinutes(t) {
  const [y, mo, d, h, mi] = TIME.exec(t).slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 60_000;
}

function fromMinutes(m) {
  return new Date(m * 60_000).toISOString().slice(0, 16);
}

export function parseLog(text) {
  const entries = [];
  let running = null;
  String(text).split('\n').forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/\s+$/, '');
    if (s.trim() === '' || s.trimStart().startsWith('#')) return;
    const fail = (why) => {
      const e = new Error(`line ${line}: ${why}`);
      e.line = line;
      throw e;
    };
    const m = /^\s*(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(s);
    if (!m) fail('expected a start, an end and a project');
    const [, start, end, project, note = ''] = m;
    if (!isTime(start)) fail(`bad start time "${start}"`);
    if (end !== '-' && !isTime(end)) fail(`bad end time "${end}"`);
    if (!isProject(project)) fail(`bad project name "${project}"`);
    if (end !== '-' && toMinutes(end) <= toMinutes(start)) fail('end is not after start');
    if (end === '-') {
      if (running) fail(`a second running entry (line ${running} is running)`);
      running = line;
    }
    entries.push({ line, project, start, end: end === '-' ? null : end, note });
  });
  return entries;
}

export function formatEntry(e) {
  return [e.start, e.end ?? '-', e.project, e.note].filter((x) => x).join(' ');
}

const span = (e, now) => [toMinutes(e.start), e.end ? toMinutes(e.end) : Math.max(toMinutes(now), toMinutes(e.start))];

export function duration(e, now) {
  const [a, b] = span(e, now);
  return b - a;
}

export function roundMinutes(m) {
  return Math.floor((m + 7) / 15) * 15;
}

export function formatDuration(m) {
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** minutes of each entry inside [from, to), keyed by key(entry) */
function within(entries, from, to, now, key) {
  const out = new Map();
  for (const e of entries) {
    const [a, b] = span(e, now);
    const m = Math.min(b, to) - Math.max(a, from);
    if (m > 0) out.set(key(e), (out.get(key(e)) ?? 0) + m);
  }
  return out;
}

const rowsOf = (map, name) => [...map.keys()].sort().map((k) => ({ [name]: k, minutes: roundMinutes(map.get(k)) }));
const sum = (rows) => rows.reduce((t, r) => t + r.minutes, 0);

export function dayReport(entries, date, now) {
  const from = toMinutes(`${date}T00:00`);
  const rows = rowsOf(within(entries, from, from + 1440, now, (e) => e.project), 'project');
  return { date, rows, total: sum(rows) };
}

export function weekReport(entries, date, now) {
  const d = new Date(toMinutes(`${date}T00:00`) * 60_000);
  const monday = toMinutes(`${date}T00:00`) - ((d.getUTCDay() + 6) % 7) * 1440;
  const days = new Map();
  for (let i = 0; i < 7; i++) {
    const from = monday + i * 1440;
    const m = [...within(entries, from, from + 1440, now, () => 'x').values()][0];
    if (m) days.set(fromMinutes(from).slice(0, 10), m);
  }
  const rows = rowsOf(days, 'date');
  return { start: fromMinutes(monday).slice(0, 10), rows, total: sum(rows) };
}

export function projectReport(entries, now) {
  const rows = rowsOf(within(entries, -Infinity, Infinity, now, (e) => e.project), 'project');
  return { rows, total: sum(rows) };
}

export function findOverlaps(entries, now) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [a1, b1] = span(entries[i], now);
      const [a2, b2] = span(entries[j], now);
      if (a1 < b2 && a2 < b1) out.push([entries[i].line, entries[j].line]);
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(entries) {
  const rows = entries.filter((e) => e.end).map((e) =>
    [e.project, e.start, e.end, String(duration(e)), e.note].map(csvField).join(','));
  return ['project,start,end,minutes,note', ...rows].map((r) => r + '\n').join('');
}

export function formatDay(r) {
  return [r.date, ...r.rows.map((x) => `${x.project} ${formatDuration(x.minutes)}`), `total ${formatDuration(r.total)}`].join('\n');
}

export function formatWeek(r) {
  return [`week of ${r.start}`, ...r.rows.map((x) => `${x.date} ${formatDuration(x.minutes)}`), `total ${formatDuration(r.total)}`].join('\n');
}

export function formatProjects(r) {
  return [...r.rows.map((x) => `${x.project} ${formatDuration(x.minutes)}`), `total ${formatDuration(r.total)}`].join('\n');
}
