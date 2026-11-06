// HX_TEST_CONCURRENCY (#350): how many test files at once a run of tests hx starts or hosts may use (a session, a gate
// run, a ship --resume), so the workers and the gate share the CPUs instead of each running cpus - 1 files. Pure but for
// the default cpus.
import os from 'node:os';

/** config.testConcurrency: "auto" = the formula, a positive integer = that value whatever the load, 0 = not set. */
export type TestConcurrency = 'auto' | number;

/** max(1, floor((cpus - 1) / n)): the CPUs less one, shared by the n running units of work (the one starting counted). */
export function concurrencyFor(cpus: number, n: number): number {
  return Math.max(1, Math.floor((cpus - 1) / Math.max(1, n)));
}

/** The value hx sets for a run starting with `n` running (itself counted); null for 0: the variable is not set. */
export function testConcurrencyValue(setting: TestConcurrency, n: number, cpus = os.availableParallelism()): number | null {
  if (setting === 0) return null;
  return setting === 'auto' ? concurrencyFor(cpus, n) : setting;
}

/** The env entry for a value: HX_TEST_CONCURRENCY, or nothing for null. */
export function concurrencyEnv(v: number | null): Record<string, string> {
  return v === null ? {} : { HX_TEST_CONCURRENCY: String(v) };
}

/** Outside hx run (hx grill / hx issue, hx health --fix, hx release): n = 1, the run itself; no runner is looked for. */
export function outsideTestEnv(c: { testConcurrency: TestConcurrency }): Record<string, string> {
  return concurrencyEnv(testConcurrencyValue(c.testConcurrency, 1));
}

/** What is wrong with config.testConcurrency, or null when it is valid (unset included). */
export function testConcurrencyError(v: unknown): string | null {
  if (v === undefined || v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 0)) return null;
  return `testConcurrency: ${JSON.stringify(v)} must be "auto", a whole number of test files above 0, or 0 (hx does not set HX_TEST_CONCURRENCY)`;
}
