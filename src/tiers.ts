// The tier check's thresholds (PRD #422): Direct (one interactive session), One child (one engine-filed issue)
// or Fleet (the full decompose). Pure: the skill, the grill prompt and `hx prd` read their numbers from here.
//
// The numbers are provisional: the large-fixture benchmark (where the fleet starts to pay off) will recalibrate them.

/** Direct: at most this many acceptance criteria. */
export const DIRECT_MAX_CRITERIA = 8;
/** Direct: an estimated diff of at most this many changed lines … */
export const DIRECT_MAX_LINES = 500;
/** … or this many files. */
export const DIRECT_MAX_FILES = 10;
/** Direct: the job takes under about this many minutes (when the user is not around). */
export const DIRECT_MAX_MINUTES = 45;
/** Fleet: more than this many acceptance criteria. */
export const FLEET_MIN_CRITERIA = 15;

// Rough estimates: the project benchmark medians (docs/benchmark.md, 2026-11-08), one brief that fits one session.
export const DIRECT_EST_MINUTES = 3.2;
export const DIRECT_EST_DOLLARS = 0.68;
export const FLEET_EST_WORKERS = 3;
export const FLEET_EST_MINUTES = 26.3;
export const FLEET_EST_DOLLARS = 6.53;

/** The Tiers table (markdown) with every threshold from the constants, then one line of rough estimates. */
export function tierTable(): string {
  return [
    '| Tier | When (provisional) | What happens |',
    '|---|---|---|',
    `| **Direct** | Fits one session: one subsystem, at most about ${DIRECT_MAX_CRITERIA} acceptance criteria, an estimated diff of at most about ${DIRECT_MAX_LINES} changed lines or ${DIRECT_MAX_FILES} files, and the user is around or the job takes under about ${DIRECT_MAX_MINUTES} min. | The interactive session does the work itself, on a branch, with a PR. No PRD, no \`hx init\` if the repo has none, no workers. |`,
    '| **One child** | Fits one session, but the user wants it unattended, or wants independent checks (audit, review, security) because the area is risky: security, money, data migration, deletion. | A PRD is filed as today. The engine files one child issue itself, with no decompose session. |',
    `| **Fleet** | Will not fit one session: more than about ${FLEET_MIN_CRITERIA} acceptance criteria, several subsystems, a multi-step plan, two or more independent workstreams, or hours of unattended work. | Today's full flow. |`,
    '',
    `Rough estimates (project benchmark medians; rough, they scale with the size of the work): direct, one session, about ${DIRECT_EST_MINUTES} min and $${DIRECT_EST_DOLLARS.toFixed(2)}; the fleet, Hx with ${FLEET_EST_WORKERS} workers, about ${FLEET_EST_MINUTES} min and $${FLEET_EST_DOLLARS.toFixed(2)}.`,
  ].join('\n');
}

/** A tier number written as a standalone number: `\b(8|10|15|45|500)\b`, built from the five constants. */
export function tierNumberRegex(): RegExp {
  const values = [DIRECT_MAX_CRITERIA, DIRECT_MAX_LINES, DIRECT_MAX_FILES, DIRECT_MAX_MINUTES, FLEET_MIN_CRITERIA].sort((a, b) => a - b);
  return new RegExp(`\\b(${values.join('|')})\\b`);
}
