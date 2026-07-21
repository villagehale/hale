import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekWindow } from '~/lib/plan/spine';
import type { ComposeInputs } from './compose';

// Edges stubbed so the test exercises the cron ORCHESTRATION (window, idempotent
// pre-check, degradation, audit) — not infra. gather is injected via deps.
// cron.ts statically imports ./gather (for the default dep), whose query modules
// transitively pull next-auth; stub the auth edge so this Node test resolves.
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/dashboard/trail-query', () => ({ readFamilyTimezone: vi.fn() }));
vi.mock('./queries', () => ({ hasWeekPlan: vi.fn(), upsertWeekPlan: vi.fn(), readWeekPlan: vi.fn() }));
vi.mock('~/lib/cron/skill', () => ({ loadWeekSummarySkill: vi.fn() }));
vi.mock('~/lib/cron/guards', () => ({ buildCronGuardDeps: vi.fn(() => ({})) }));
vi.mock('@hale/agent', async (orig) => ({
  ...(await orig<typeof import('@hale/agent')>()),
  runAgent: vi.fn(),
}));

import { runAgent } from '@hale/agent';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { DEFAULT_LOOP_PREFS, type LoopPrefsView } from '~/lib/loop/prefs';
import { isComposeMoment, runWeekPlanForFamily, type WeekPlanDeps } from './cron';
import { hasWeekPlan, readWeekPlan, upsertWeekPlan } from './queries';

const FAMILY = '11111111-1111-4111-8111-111111111111';
// Saturday 2026-07-25 19:30 EDT → the upcoming Monday week starts 2026-07-27.
const NOW = new Date('2026-07-25T23:30:00Z');
const WEEK_START = '2026-07-27';

const asMock = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

/** A gather that returns one in-window village item so compose yields a non-empty plan. */
function fakeGather(): WeekPlanDeps['gather'] {
  return vi.fn(async (_db, _familyId, window: WeekWindow): Promise<ComposeInputs> => ({
    window,
    children: [],
    health: [],
    routines: [],
    villageDated: [{ id: 'v1', title: 'Storytime', eventDate: window.startKey, location: null }],
    suggestion: null,
    familyEvents: [],
  }));
}

function fakeDb() {
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({ values: async (v: Record<string, unknown>) => void audits.push(v) }),
  } as unknown as Database;
  return { db, audits };
}

describe('runWeekPlanForFamily', () => {
  beforeEach(() => {
    asMock(readFamilyTimezone).mockResolvedValue('America/Toronto');
    asMock(readWeekPlan).mockResolvedValue({ id: 'wp-1' });
    asMock(upsertWeekPlan).mockResolvedValue(undefined);
    asMock(hasWeekPlan).mockReset();
    asMock(runAgent).mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('skips (no gather, no upsert, no spend) when the week is already composed', async () => {
    asMock(hasWeekPlan).mockResolvedValue(true);
    const gather = fakeGather();
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather }, NOW);

    expect(result).toEqual({ familyId: FAMILY, status: 'skipped_existing', weekStart: WEEK_START });
    expect(gather).not.toHaveBeenCalled();
    expect(upsertWeekPlan).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('composes + persists WITHOUT the LLM when the client is absent (graceful degradation)', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    const gather = fakeGather();
    const { db, audits } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: null, gather }, NOW);

    expect(result).toMatchObject({ status: 'composed', weekStart: WEEK_START, itemCount: 1, summarized: false });
    expect(runAgent).not.toHaveBeenCalled();
    expect(upsertWeekPlan).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ familyId: FAMILY, weekStart: WEEK_START, summary: null }),
    );
    // Rule #6: an immutable audit row for the compose.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ familyId: FAMILY, actor: 'system', actionTaken: 'compose_week_plan', targetTable: 'week_plans', targetId: 'wp-1' });
  });

  it('persists the one-sentence summary when the agent step succeeds', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(runAgent).mockResolvedValue({ answer: 'a calm week — one storytime to enjoy.', steps: 1, hitMaxSteps: false, usage: { promptTokens: 0, completionTokens: 0 } });
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather: fakeGather() }, NOW);

    expect(result).toMatchObject({ status: 'composed', summarized: true });
    expect(upsertWeekPlan).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ summary: 'a calm week — one storytime to enjoy.' }),
    );
  });

  it('degrades to no summary — but still persists the plan — when the agent step throws', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(runAgent).mockRejectedValue(new Error('model timeout'));
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather: fakeGather() }, NOW);

    expect(result).toMatchObject({ status: 'composed', summarized: false });
    expect(upsertWeekPlan).toHaveBeenCalledWith(db, expect.objectContaining({ summary: null }));
  });
});

/** The UTC instant a given family-local wall-clock maps to in `tz` (DST-correct via
 * the offset at that instant). */
function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(guess);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

const prefs = (over: Partial<LoopPrefsView> = {}): LoopPrefsView => ({ ...DEFAULT_LOOP_PREFS, ...over });
const TZ = 'America/Toronto';

/**
 * The composer runs the evening BEFORE the parent's VIL-216 send moment. For a
 * Monday-start week the send weekday is Sunday (weeklyPlanWeekday(1)=0), so compose
 * runs SATURDAY at the parent's weekly_plan_send_time (default 19:30), within a
 * one-hour slot — asserted from first principles across DST + offset zones + the
 * per-parent send time, never read back from the function.
 */
describe('isComposeMoment — the family-local compose slot (day before the send moment)', () => {
  it('matches Saturday from the send time through <60 min later (Monday-start week)', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 19, 30, TZ), TZ, 1)).toBe(true); // Sat 19:30
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 20, 29, TZ), TZ, 1)).toBe(true); // +59
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 19, 29, TZ), TZ, 1)).toBe(false); // 1 early
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 20, 30, TZ), TZ, 1)).toBe(false); // +60
  });

  it('does NOT fire on the SEND day (Sunday) — that is B2 delivery, not compose', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 19, 30, TZ), TZ, 1)).toBe(false); // Sunday
  });

  it('honors the parent per-parent weekly_plan_send_time', () => {
    const p = prefs({ weeklyPlanSendTime: '08:00:00' });
    expect(isComposeMoment(p, zoned(2026, 7, 25, 8, 15, TZ), TZ, 1)).toBe(true); // Sat 08:15
    expect(isComposeMoment(p, zoned(2026, 7, 25, 19, 30, TZ), TZ, 1)).toBe(false); // default time no longer matches
  });

  it('reads the offset live across DST (winter EST) and catches a :45 zone', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 1, 31, 19, 30, TZ), TZ, 1)).toBe(true); // Sat 19:30 EST
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 19, 45, 'Asia/Kathmandu'), 'Asia/Kathmandu', 1)).toBe(true);
  });

  it('shifts the compose day with the parent week-start (Sunday-start → compose Friday)', () => {
    // weekStartDay 0 → send Saturday (weeklyPlanWeekday(0)=6) → compose Friday.
    expect(isComposeMoment(prefs(), zoned(2026, 7, 24, 19, 30, TZ), TZ, 0)).toBe(true); // Friday
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 19, 30, TZ), TZ, 0)).toBe(false); // Saturday
  });
});
