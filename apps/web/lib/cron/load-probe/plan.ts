/**
 * The launch load the drain probe replays (VIL-314): which family texts when, and how
 * long its turn holds the drain. Seeded, so a run can be repeated exactly.
 *
 * TURN TIME is the one input the probe does not produce itself: it is the model's part of
 * a turn, and the probe measures the drain around it, not the model. It is drawn from a
 * log-normal fitted to production — `channel.message.received` jobs from real families,
 * started_on → completed_on, 2026-11-04..06: median 35 s, p95 66 s — and capped at the
 * router's own turn deadline, past which a real turn defers instead of running on.
 */

export const PROD_TURN_MEDIAN_MS = 35_000;
export const PROD_TURN_P95_MS = 66_000;
/** z for the 95th percentile of a standard normal. */
const Z95 = 1.6449;

export interface ProbeArrival {
  /** Offset from the start of the run. */
  atMs: number;
  family: number;
  /** How long this text's turn holds its drain run. */
  turnMs: number;
}

export interface ProbePlanInput {
  families: number;
  /** Every first text lands inside this window. */
  windowMs: number;
  /** Texts per family. The first lands in the window; each later one follows its own
   * reply's expected arrival by `followUpGapMs`, so a family keeps chatting. */
  textsPerFamily: number;
  followUpGapMs: number;
  /** A fraction (0..1) of first texts that land inside the first `burstMs` of the window
   * instead of spread across it: an ad going out. */
  burstShare: number;
  burstMs: number;
  turnCapMs: number;
  seed: number;
}

/** mulberry32: small, seedable, good enough to spread arrivals. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(next: () => number): number {
  const u = Math.max(next(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

export function sampleTurnMs(next: () => number, capMs: number): number {
  const sigma = Math.log(PROD_TURN_P95_MS / PROD_TURN_MEDIAN_MS) / Z95;
  return Math.min(capMs, Math.round(PROD_TURN_MEDIAN_MS * Math.exp(sigma * standardNormal(next))));
}

export function buildProbePlan(input: ProbePlanInput): ProbeArrival[] {
  if (!Number.isInteger(input.families) || input.families < 1) {
    throw new Error('families must be a positive integer');
  }
  if (!Number.isInteger(input.textsPerFamily) || input.textsPerFamily < 1) {
    throw new Error('textsPerFamily must be a positive integer');
  }
  if (input.burstShare < 0 || input.burstShare > 1) throw new Error('burstShare must be 0..1');
  const next = rng(input.seed);
  const arrivals: ProbeArrival[] = [];
  for (let family = 0; family < input.families; family += 1) {
    const span = next() < input.burstShare ? input.burstMs : input.windowMs;
    let atMs = Math.floor(next() * span);
    for (let text = 0; text < input.textsPerFamily; text += 1) {
      const turnMs = sampleTurnMs(next, input.turnCapMs);
      arrivals.push({ atMs, family, turnMs });
      atMs += turnMs + input.followUpGapMs;
    }
  }
  return arrivals.sort((a, b) => a.atMs - b.atMs);
}
