import type { ReplyLanguage } from '~/lib/channel/language';
import { type ClaimCandidateRow, buildClaimCandidates } from './candidates';
import {
  CLAIM_READ_MAX_BUDGET_MS,
  type ClaimReadFailure,
  type ClaimReadOutcome,
  type ClaimReader,
} from './claim-reader';
import { verifyClaimRead } from './claim-verdict';
import type { ClaimReaderMode } from './flag';
import { claimReadLocale } from './sentences';

/**
 * VIL-581 · warm and probe, behind /api/cron/claim-read-warm.
 *
 * Every case is synthetic: the family id is the constant 'probe', the one row is an
 * invented swim lesson, and nothing is read from or written to a family. No send.
 *
 *  - WARM compiles the output grammar on both lanes the reader can use (the skill's
 *    adaptive lane and its thinking-off form) before a parent's text ever needs it.
 *    It runs only when CLAIM_READER_MODE is not off: the flag's PR 1 consumer.
 *  - PROBE ignores the flag: it is how a deploy is proven before the flag moves. Its
 *    first case's latency is the cold-compile measurement under the production key.
 */

const PROBE_FAMILY = 'probe';
const PROBE_TIME_ZONE = 'America/Edmonton';
const PROBE_NOW = new Date('2026-11-03T17:00:00Z');
const PROBE_ROWS: readonly ClaimCandidateRow[] = [
  {
    familyId: PROBE_FAMILY,
    source: 'calendar',
    kind: 'scheduled_event',
    what: 'Swim lesson',
    startsAt: new Date('2026-11-07T17:00:00Z'),
  },
];

export interface ProbeCase {
  id: string;
  language: ReplyLanguage;
  body: string;
  expected: 'refused' | 'backed';
}

export const CLAIM_READ_PROBE_CASES: readonly ProbeCase[] = [
  { id: 'en-false', language: 'en', body: 'Your dentist visit is booked.', expected: 'refused' },
  {
    id: 'en-true',
    language: 'en',
    body: 'Your Saturday swim lesson is booked.',
    expected: 'backed',
  },
  {
    id: 'fr-false',
    language: 'fr',
    body: 'Ton rendez-vous chez le dentiste est réservé.',
    expected: 'refused',
  },
  {
    id: 'fr-true',
    language: 'fr',
    body: 'Ta leçon de natation de samedi est réservée.',
    expected: 'backed',
  },
  { id: 'zh-false', language: 'zh', body: '你的牙医预约已经约好了。', expected: 'refused' },
  { id: 'zh-true', language: 'zh', body: '你周六的游泳课已经约好了。', expected: 'backed' },
  {
    id: 'es-false',
    language: 'es',
    body: 'Tu cita con el dentista está reservada.',
    expected: 'refused',
  },
  {
    id: 'es-true',
    language: 'es',
    body: 'Tu clase de natación del sábado está reservada.',
    expected: 'backed',
  },
];

export type WarmResult =
  | { mode: 'warm'; skipped: 'reader_off' }
  | {
      mode: 'warm';
      reads: { lane: 'adaptive' | 'off'; outcome: 'read' | ClaimReadFailure; latencyMs: number }[];
    };

type ProbeGot = 'refused' | 'backed' | 'no_claim' | `failed:${ClaimReadFailure}`;

export interface ProbeResult {
  mode: 'probe';
  ok: boolean;
  cases: {
    id: string;
    language: ReplyLanguage;
    expected: ProbeCase['expected'];
    got: ProbeGot;
    latencyMs: number;
  }[];
}

async function readCase(reader: ClaimReader, probe: ProbeCase) {
  const candidates = buildClaimCandidates(PROBE_FAMILY, PROBE_ROWS, PROBE_TIME_ZONE);
  const outcome = await reader.read({
    body: probe.body,
    language: probe.language,
    timeZone: PROBE_TIME_ZONE,
    now: PROBE_NOW,
    candidates,
    signal: new AbortController().signal,
    budgetMs: CLAIM_READ_MAX_BUDGET_MS,
  });
  return { outcome, candidates };
}

function gotFor(
  outcome: ClaimReadOutcome,
  candidates: ReturnType<typeof buildClaimCandidates>,
  language: ReplyLanguage,
): ProbeGot {
  if (outcome.status === 'failed') return `failed:${outcome.reason}`;
  const verdict = verifyClaimRead(outcome, {
    candidates,
    locale: claimReadLocale(language),
    timeZone: PROBE_TIME_ZONE,
  });
  if (verdict.refusedSegments.length > 0) return 'refused';
  return verdict.resolutions.length > 0 ? 'backed' : 'no_claim';
}

export async function runClaimReadWarm(deps: {
  readers: { adaptive: ClaimReader; off: ClaimReader };
  mode: ClaimReaderMode;
}): Promise<WarmResult> {
  if (deps.mode === 'off') return { mode: 'warm', skipped: 'reader_off' };
  const probe = CLAIM_READ_PROBE_CASES[0] as ProbeCase;
  const reads: Extract<WarmResult, { reads: unknown }>['reads'] = [];
  for (const lane of ['adaptive', 'off'] as const) {
    const { outcome } = await readCase(deps.readers[lane], probe);
    reads.push({
      lane,
      outcome: outcome.status === 'read' ? 'read' : outcome.reason,
      latencyMs: outcome.latencyMs,
    });
  }
  return { mode: 'warm', reads };
}

export async function runClaimReadProbe(deps: { reader: ClaimReader }): Promise<ProbeResult> {
  const cases: ProbeResult['cases'] = [];
  for (const probe of CLAIM_READ_PROBE_CASES) {
    const { outcome, candidates } = await readCase(deps.reader, probe);
    cases.push({
      id: probe.id,
      language: probe.language,
      expected: probe.expected,
      got: gotFor(outcome, candidates, probe.language),
      latencyMs: outcome.latencyMs,
    });
  }
  return { mode: 'probe', ok: cases.every((c) => c.got === c.expected), cases };
}

/**
 * How the probe script reads the route's answer. A skip (Preview), a non-200 or a body
 * with no cases is "not run" (exit 2), never a pass; a wrong verdict or a failed read is
 * exit 1.
 */
export function probeExitFor(status: number, body: unknown): { code: 0 | 1 | 2; lines: string[] } {
  if (status !== 200) return { code: 2, lines: [`probe: not run (http ${status})`] };
  const answer = (body ?? {}) as { ok?: unknown; skipped?: unknown; cases?: unknown };
  if (typeof answer.skipped === 'string') {
    return { code: 2, lines: [`probe: not run (${answer.skipped})`] };
  }
  if (!Array.isArray(answer.cases)) return { code: 2, lines: ['probe: not run (no_cases)'] };
  const cases = answer.cases as ProbeResult['cases'];
  const lines = cases.map(
    (c) =>
      `${c.got === c.expected ? 'ok   ' : 'WRONG'} ${c.id} expected=${c.expected} got=${c.got} ${c.latencyMs}ms`,
  );
  const right = answer.ok === true && cases.every((c) => c.got === c.expected);
  return { code: right ? 0 : 1, lines };
}
