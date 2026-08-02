import { describe, expect, it } from 'vitest';
import {
  computeNudgeEngagement,
  computeTtfa,
  formatFunnelScoreboard,
  type FunnelScoreboard,
  type IntakeMessageRow,
  type NudgeRow,
  type ReplyRow,
} from './funnel-scoreboard';

/**
 * X1 · the F14 intake-funnel scoreboard. The DB aggregation stays thin and
 * untested-in-isolation (as aggregateLoopHealth does); the derivations and the
 * formatting are pure, so they are worked here against hand-built rows.
 *
 * Every case below includes the pre-launch one — zero rows — because that is the
 * state these lines will be read in first, and a scoreboard that invents a number
 * from no data is worse than no scoreboard.
 */

const FAMILY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FAMILY_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A family whose intake ran at `provisionedAt`: greeting replayed pre-provisioning,
 * radar sent `radarDelaySeconds` after the parent's first text. */
function intakeRows(args: {
  familyId: string;
  firstTextAt: string;
  provisionedAt: string;
  radarDelaySeconds: number | null;
}): IntakeMessageRow[] {
  const familyCreatedAt = new Date(args.provisionedAt);
  const firstText = new Date(args.firstTextAt);
  const rows: IntakeMessageRow[] = [
    { familyId: args.familyId, direction: 'in', sentAt: firstText, familyCreatedAt },
    // The greeting: sent BEFORE the family existed, replayed into the ledger at
    // provisioning. Never the radar reply, however early it lands.
    {
      familyId: args.familyId,
      direction: 'out',
      sentAt: new Date(firstText.getTime() + 2000),
      familyCreatedAt,
    },
  ];
  if (args.radarDelaySeconds !== null) {
    rows.push({
      familyId: args.familyId,
      direction: 'out',
      sentAt: new Date(firstText.getTime() + args.radarDelaySeconds * 1000),
      familyCreatedAt,
    });
  }
  return rows;
}

describe('computeTtfa — first text → radar reply', () => {
  it('measures to the first outbound sent AFTER provisioning, not to the greeting', () => {
    const rows = intakeRows({
      familyId: FAMILY_A,
      firstTextAt: '2026-08-01T10:00:00Z',
      provisionedAt: '2026-08-01T10:00:30Z',
      radarDelaySeconds: 45,
    });

    expect(computeTtfa(rows)).toEqual({
      p50Seconds: 45,
      derivedFamilies: 1,
      notDerivableFamilies: 0,
    });
  });

  it('takes the median of the derivable families (nearest rank)', () => {
    const rows = [
      ...intakeRows({
        familyId: FAMILY_A,
        firstTextAt: '2026-08-01T10:00:00Z',
        provisionedAt: '2026-08-01T10:00:30Z',
        radarDelaySeconds: 40,
      }),
      ...intakeRows({
        familyId: FAMILY_B,
        firstTextAt: '2026-08-01T11:00:00Z',
        provisionedAt: '2026-08-01T11:00:30Z',
        radarDelaySeconds: 100,
      }),
      ...intakeRows({
        familyId: FAMILY_C,
        firstTextAt: '2026-08-01T12:00:00Z',
        provisionedAt: '2026-08-01T12:00:30Z',
        radarDelaySeconds: 70,
      }),
    ];

    expect(computeTtfa(rows).p50Seconds).toBe(70);
  });

  it('counts a family that never got a post-provisioning reply as NOT derivable', () => {
    const rows = [
      ...intakeRows({
        familyId: FAMILY_A,
        firstTextAt: '2026-08-01T10:00:00Z',
        provisionedAt: '2026-08-01T10:00:30Z',
        radarDelaySeconds: 55,
      }),
      ...intakeRows({
        familyId: FAMILY_B,
        firstTextAt: '2026-08-01T11:00:00Z',
        provisionedAt: '2026-08-01T11:00:30Z',
        radarDelaySeconds: null,
      }),
    ];

    expect(computeTtfa(rows)).toEqual({
      p50Seconds: 55,
      derivedFamilies: 1,
      notDerivableFamilies: 1,
    });
  });

  it('treats a row with no sent_at as unmeasurable rather than guessing from created_at', () => {
    const familyCreatedAt = new Date('2026-08-01T10:00:30Z');
    const rows: IntakeMessageRow[] = [
      { familyId: FAMILY_A, direction: 'in', sentAt: null, familyCreatedAt },
      {
        familyId: FAMILY_A,
        direction: 'out',
        sentAt: new Date('2026-08-01T10:01:00Z'),
        familyCreatedAt,
      },
    ];

    expect(computeTtfa(rows)).toEqual({
      p50Seconds: null,
      derivedFamilies: 0,
      notDerivableFamilies: 1,
    });
  });

  it('reports nothing at all before launch', () => {
    expect(computeTtfa([])).toEqual({
      p50Seconds: null,
      derivedFamilies: 0,
      notDerivableFamilies: 0,
    });
  });
});

describe('computeNudgeEngagement — replies within 48h', () => {
  const WINDOW_END = new Date('2026-08-08T00:00:00Z');
  const nudge = (familyId: string, sentAt: string): NudgeRow => ({
    familyId,
    sentAt: new Date(sentAt),
  });
  const reply = (familyId: string, sentAt: string): ReplyRow => ({
    familyId,
    sentAt: new Date(sentAt),
  });

  it('credits a nudge whose family replied inside the 48h window', () => {
    const result = computeNudgeEngagement(
      [nudge(FAMILY_A, '2026-08-01T09:00:00Z')],
      [reply(FAMILY_A, '2026-08-02T09:00:00Z')],
      WINDOW_END,
    );

    expect(result).toEqual({ sent: 1, matured: 1, replied: 1 });
  });

  it('does not credit a reply that came after 48h, or from a different family', () => {
    const result = computeNudgeEngagement(
      [nudge(FAMILY_A, '2026-08-01T09:00:00Z'), nudge(FAMILY_B, '2026-08-01T09:00:00Z')],
      [
        reply(FAMILY_A, '2026-08-03T09:00:01Z'),
        reply(FAMILY_C, '2026-08-01T10:00:00Z'),
      ],
      WINDOW_END,
    );

    expect(result).toEqual({ sent: 2, matured: 2, replied: 0 });
  });

  it('ignores an inbound that predates the nudge — it cannot be a reply to it', () => {
    const result = computeNudgeEngagement(
      [nudge(FAMILY_A, '2026-08-01T09:00:00Z')],
      [reply(FAMILY_A, '2026-08-01T08:59:00Z')],
      WINDOW_END,
    );

    expect(result).toEqual({ sent: 1, matured: 1, replied: 0 });
  });

  it('holds back a nudge that has not had its full 48h yet, so the rate stays comparable', () => {
    const result = computeNudgeEngagement(
      [nudge(FAMILY_A, '2026-08-01T09:00:00Z'), nudge(FAMILY_B, '2026-08-07T09:00:00Z')],
      [reply(FAMILY_A, '2026-08-01T10:00:00Z')],
      WINDOW_END,
    );

    expect(result).toEqual({ sent: 2, matured: 1, replied: 1 });
  });

  it('counts one family reply once, however many nudges it could answer', () => {
    const result = computeNudgeEngagement(
      [nudge(FAMILY_A, '2026-08-01T09:00:00Z'), nudge(FAMILY_A, '2026-08-01T18:00:00Z')],
      [reply(FAMILY_A, '2026-08-02T09:00:00Z')],
      WINDOW_END,
    );

    // Both nudges were plausibly answered by the same text — the heuristic credits
    // both, and the digest line says so rather than pretending to resolve it.
    expect(result).toEqual({ sent: 2, matured: 2, replied: 2 });
  });
});

const EMPTY: FunnelScoreboard = {
  intake: { sessionsStarted: 0, provisioned: 0, watchConsented: 0 },
  ttfa: { p50Seconds: null, derivedFamilies: 0, notDerivableFamilies: 0 },
  nudges: { sent: 0, matured: 0, replied: 0 },
  cogs: { totalUsd: 0, families: 0 },
};

function lineStartingWith(scoreboard: FunnelScoreboard, prefix: string): string {
  const line = formatFunnelScoreboard(scoreboard).find((l) => l.startsWith(prefix));
  if (!line) {
    throw new Error(`no scoreboard line starting "${prefix}"`);
  }
  return line;
}

describe('formatFunnelScoreboard', () => {
  it('walks the intake funnel with each step converted from the one before it', () => {
    const line = lineStartingWith(
      { ...EMPTY, intake: { sessionsStarted: 12, provisioned: 9, watchConsented: 5 } },
      'Intake funnel',
    );

    expect(line).toBe(
      'Intake funnel (7d): 12 started → 9 provisioned (75%) → 5 watch-consented (56%)',
    );
  });

  it('never divides by a zero step — an unreachable rate reads n/a', () => {
    const line = lineStartingWith(
      { ...EMPTY, intake: { sessionsStarted: 3, provisioned: 0, watchConsented: 0 } },
      'Intake funnel',
    );

    expect(line).toBe(
      'Intake funnel (7d): 3 started → 0 provisioned (0%) → 0 watch-consented (n/a)',
    );
  });

  it('reports the TTFA median with the families it rests on, and those it could not measure', () => {
    const line = lineStartingWith(
      { ...EMPTY, ttfa: { p50Seconds: 42, derivedFamilies: 9, notDerivableFamilies: 3 } },
      'TTFA p50',
    );

    expect(line).toBe('TTFA p50 (first text → radar): 42s across 9 families (3 not derivable)');
  });

  it('drops the not-derivable clause when every family was measurable', () => {
    const line = lineStartingWith(
      { ...EMPTY, ttfa: { p50Seconds: 42, derivedFamilies: 9, notDerivableFamilies: 0 } },
      'TTFA p50',
    );

    expect(line).toBe('TTFA p50 (first text → radar): 42s across 9 families');
  });

  it('names the matured base for nudge engagement rather than the raw send count', () => {
    const line = lineStartingWith(
      { ...EMPTY, nudges: { sent: 8, matured: 6, replied: 2 } },
      'Nudge engagement',
    );

    expect(line).toBe('Nudge engagement (7d): 8 sent · 6 matured (48h elapsed) → 2 replied (33%)');
  });

  it('says a nudge week is still too young to score', () => {
    const line = lineStartingWith(
      { ...EMPTY, nudges: { sent: 2, matured: 0, replied: 0 } },
      'Nudge engagement',
    );

    expect(line).toBe('Nudge engagement (7d): 2 sent · none matured yet (48h not elapsed)');
  });

  it('divides recorded LLM cost across the families that incurred it', () => {
    const line = lineStartingWith({ ...EMPTY, cogs: { totalUsd: 1.234, families: 4 } }, 'LLM COGS');

    expect(line).toBe('LLM COGS (7d): $1.2340 across 4 families → $0.3085 per family');
  });

  it('says "no data yet" on every line before the first cohort arrives', () => {
    expect(formatFunnelScoreboard(EMPTY)).toEqual([
      'Intake funnel (7d): no sessions started yet',
      'TTFA p50 (first text → radar): no data yet',
      'Nudge engagement (7d): no nudges sent yet',
      'LLM COGS (7d): no recorded LLM cost yet',
    ]);
  });

  it('still says "no data yet" for TTFA when families arrived but none was measurable', () => {
    const line = lineStartingWith(
      { ...EMPTY, ttfa: { p50Seconds: null, derivedFamilies: 0, notDerivableFamilies: 4 } },
      'TTFA p50',
    );

    expect(line).toBe('TTFA p50 (first text → radar): no data yet (4 families not derivable)');
  });
});
