// Usage-window readings (.hx/usage-readings.jsonl): what becomes a reading, and when one is appended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readingOf, readingsFile, readReadings, recordReading, type Reading } from '../src/budget.ts';
import { rateLimitOf } from '../src/agents/claude.ts';

const now = new Date('2026-11-02T10:00:00.000Z');
const ev = (info: Record<string, unknown>) => rateLimitOf({ type: 'rate_limit_event', rate_limit_info: info })!;
const dir = () => mkdtempSync(path.join(os.tmpdir(), 'hx-b-'));
const r = (window: string, utilization: number, resetsAt = 1000): Reading => ({ ts: now.toISOString(), window, utilization, resetsAt });

test('readingsFile is <stateDir>/usage-readings.jsonl', () => {
  assert.equal(readingsFile('x'), path.join('x', 'usage-readings.jsonl'));
});

test('readingOf: null without numeric utilization, without rateLimitType or without resetsAt', () => {
  assert.equal(readingOf(ev({ status: 'allowed_warning', resetsAt: 1000, rateLimitType: 'five_hour' }), now), null);
  assert.equal(readingOf(ev({ status: 'rejected', resetsAt: 1000 }), now), null);
  assert.equal(readingOf(ev({ status: 'allowed', utilization: '0.5', resetsAt: 1000, rateLimitType: 'five_hour' }), now), null);
  assert.equal(readingOf(ev({ status: 'allowed', utilization: 0.5, resetsAt: 1000 }), now), null);
  assert.equal(readingOf(ev({ status: 'allowed', utilization: 0.5, resetsAt: 1000, rateLimitType: '' }), now), null);
  assert.equal(readingOf(ev({ status: 'allowed', utilization: 0.5, rateLimitType: 'five_hour' }), now), null);
  assert.equal(readingOf(ev({ status: 'allowed', utilization: 0.5, resetsAt: '1000', rateLimitType: 'five_hour' }), now), null);
});

test('readingOf: a reading with utilization normalised to 0..1, ts = the time of receipt', () => {
  assert.deepEqual(readingOf(ev({ status: 'allowed', utilization: 0.42, resetsAt: 1000, rateLimitType: 'five_hour' }), now),
    { ts: '2026-11-02T10:00:00.000Z', window: 'five_hour', utilization: 0.42, resetsAt: 1000 });
  assert.deepEqual(readingOf(ev({ status: 'allowed_warning', utilization: 85, resetsAt: 2000, rateLimitType: 'seven_day' }), now),
    { ts: '2026-11-02T10:00:00.000Z', window: 'seven_day', utilization: 0.85, resetsAt: 2000 });
});

test('readReadings: a missing file is []', () => {
  assert.deepEqual(readReadings(path.join(dir(), 'nope')), []);
});

test('readReadings: bad lines are skipped, the good readings returned', () => {
  const d = dir();
  const good1 = r('five_hour', 0.1), good2 = r('seven_day', 0.2, 2000);
  writeFileSync(readingsFile(d), [
    JSON.stringify(good1),
    '{not json',
    JSON.stringify({ ts: now.toISOString(), utilization: 0.3, resetsAt: 1 }), // no window
    JSON.stringify({ ts: now.toISOString(), window: 'five_hour', utilization: '0.3', resetsAt: 1 }),
    JSON.stringify({ ts: now.toISOString(), window: 'five_hour', utilization: 0.3 }),
    JSON.stringify({ window: 'five_hour', utilization: 0.3, resetsAt: 1 }), // no ts
    JSON.stringify({ ts: 5, window: 'five_hour', utilization: 0.3, resetsAt: 1 }),
    'null',
    '42',
    '',
    JSON.stringify(good2),
  ].join('\n') + '\n');
  assert.deepEqual(readReadings(d), [good1, good2]);
});

test('recordReading: first of a window appended, an equal repeat not, a change in utilization or resetsAt appended', () => {
  const d = dir();
  assert.equal(recordReading(d, r('five_hour', 0.1)), true);
  assert.equal(recordReading(d, { ...r('five_hour', 0.1), ts: '2026-11-02T11:00:00.000Z' }), false, 'equal value, later ts');
  assert.equal(recordReading(d, r('five_hour', 0.2)), true);
  assert.equal(recordReading(d, r('five_hour', 0.2, 5000)), true, 'only resetsAt changed');
  assert.equal(recordReading(d, r('five_hour', 0.2, 5000)), false);
  assert.deepEqual(readReadings(d).map((x) => [x.utilization, x.resetsAt]), [[0.1, 1000], [0.2, 1000], [0.2, 5000]]);
});

test('recordReading: compares per window', () => {
  const d = dir();
  assert.equal(recordReading(d, r('five_hour', 0.3)), true);
  assert.equal(recordReading(d, r('seven_day', 0.5, 9000)), true, 'first of its window');
  assert.equal(recordReading(d, r('five_hour', 0.3)), false, 'the seven_day line between does not count');
  assert.equal(recordReading(d, r('seven_day', 0.5, 9000)), false);
  assert.equal(readReadings(d).length, 2);
});

test('recordReading: compares against the file, so an equal value is skipped after a restart', () => {
  const d = dir();
  // written by an earlier run: no in-memory state can know about it
  writeFileSync(readingsFile(d), JSON.stringify(r('five_hour', 0.4)) + '\n');
  assert.equal(recordReading(d, r('five_hour', 0.4)), false);
  assert.equal(recordReading(d, r('five_hour', 0.6)), true);
  // the file changes behind its back (another session): the last line of the window is what counts
  writeFileSync(readingsFile(d), readFileSync(readingsFile(d), 'utf8') + JSON.stringify(r('five_hour', 0.4)) + '\n');
  assert.equal(recordReading(d, r('five_hour', 0.4)), false);
  assert.equal(recordReading(d, r('five_hour', 0.6)), true);
});

test('recordReading: creates the state dir', () => {
  const d = path.join(dir(), 'deep', '.hx');
  assert.equal(recordReading(d, r('five_hour', 0.1)), true);
  assert.equal(readReadings(d).length, 1);
});
