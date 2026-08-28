import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekWindow } from '~/lib/plan/spine';
import type { ComposeInputs } from './compose';

// Edges stubbed so the test exercises the cron ORCHESTRATION (window, idempotent
// pre-check, voice-threading, degradation, audit) — not infra. gather is injected via
// deps. The single agent STAGE is the composeWeekVoice seam (VIL-229), mocked here so
// the cron test stays on orchestration; voice internals have their own tests.
// cron.ts statically imports ./gather (for the default dep), whose query modules
// transitively pull next-auth; stub the auth edge so this Node test resolves.
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/dashboard/trail-query', () => ({ readFamilyTimezone: vi.fn() }));
vi.mock('./queries', () => ({ hasWeekPlan: vi.fn(), upsertWeekPlan: vi.fn() }));
vi.mock('./voice/week-voice', () => ({ composeWeekVoice: vi.fn() }));

import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { DEFAULT_LOOP_PREFS, type LoopPrefsView } from '~/lib/loop/prefs';
import { isComposeMoment, runWeekPlanForFamily, type WeekPlanDeps } from './cron';
import { hasWeekPlan, upsertWeekPlan } from './queries';
import { composeWeekVoice } from './voice/week-voice';

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

/** The placement mint, faked: it is the DB+reviewer seam, and what this file tests is
 * that the compose path CALLS it with the week it just composed. */
function fakeMint(result: Awaited<ReturnType<WeekPlanDeps['mint']>> = { minted: ['act-1'], skipped: 0 }) {
  const calls: Parameters<WeekPlanDeps['mint']>[0][] = [];
  const mint: WeekPlanDeps['mint'] = async (input) => {
    calls.push(input);
    return result;
  };
  return { mint, calls };
}

function fakeDb() {
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({ values: async (v: Record<string, unknown>) => void audits.push(v) }),
  } as unknown as Database;
  return { db, audits };
}

describe('runWeekPlanForFamily', () => {
  const VOICE = {
    greeting: 'hi there, here is your week',
    weekFraming: 'a calm week — one storytime to enjoy',
    itemLines: { '0': 'a gentle outing' },
    signOff: 'reply any time',
  };

  beforeEach(() => {
    asMock(readFamilyTimezone).mockResolvedValue('America/Toronto');
    // upsertWeekPlan now returns the plan id; writeComposeAudit uses it directly (WP-11
    // removed the read-back), so the audit's targetId comes from this return.
    asMock(upsertWeekPlan).mockResolvedValue({ id: 'wp-1' });
    asMock(hasWeekPlan).mockReset();
    asMock(composeWeekVoice).mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('skips (no gather, no upsert, no voice) when the week is already composed', async () => {
    asMock(hasWeekPlan).mockResolvedValue(true);
    const gather = fakeGather();
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather, mint: fakeMint().mint }, NOW);

    expect(result).toEqual({ familyId: FAMILY, status: 'skipped_existing', weekStart: WEEK_START });
    expect(gather).not.toHaveBeenCalled();
    expect(upsertWeekPlan).not.toHaveBeenCalled();
    expect(composeWeekVoice).not.toHaveBeenCalled();
  });

  it('composes + persists WITHOUT the voice stage when the client is absent (graceful degradation)', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    const gather = fakeGather();
    const { db, audits } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: null, gather, mint: fakeMint().mint }, NOW);

    expect(result).toMatchObject({ status: 'composed', weekStart: WEEK_START, itemCount: 1, voiced: false });
    expect(composeWeekVoice).not.toHaveBeenCalled();
    expect(upsertWeekPlan).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ familyId: FAMILY, weekStart: WEEK_START, summary: null, voice: null }),
    );
    // Rule #6: an immutable audit row for the compose.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ familyId: FAMILY, actor: 'system', actionTaken: 'compose_week_plan', targetTable: 'week_plans', targetId: 'wp-1' });
  });

  it('mints the composed week\'s calendar drafts, keyed on the week it just wrote', async () => {
    // The ask the SMS sends counts these rows ("N drafted for your calendar - reply
    // YES"), so a plan composed without them promises approvals that do not exist.
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(composeWeekVoice).mockResolvedValue({ voice: null, degraded: false });
    const { db } = fakeDb();
    const { mint, calls } = fakeMint({ minted: ['act-1'], skipped: 0 });

    const result = await runWeekPlanForFamily(
      FAMILY,
      db,
      { client: {} as never, gather: fakeGather(), mint },
      NOW,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      familyId: FAMILY,
      weekStart: WEEK_START,
      timeZone: 'America/Toronto',
      actor: 'system',
    });
    // The items it mints from are the ones it just persisted — one shared array.
    expect(calls[0]?.items).toHaveLength(1);
    expect(result).toMatchObject({ status: 'composed', drafted: 1 });
  });

  it('NAMES the absence of a reviewer rather than reporting zero drafts (rule #11)', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(composeWeekVoice).mockResolvedValue({ voice: null, degraded: false });
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(
      FAMILY,
      db,
      { client: {} as never, gather: fakeGather(), mint: fakeMint('no_reviewer').mint },
      NOW,
    );

    // A truthful-looking 0 would be indistinguishable from "this week needed none".
    expect(result).toMatchObject({ status: 'composed', drafted: 'no_reviewer' });
  });

  it('persists the voice + its framing as summary when the voice stage succeeds', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(composeWeekVoice).mockResolvedValue({ voice: VOICE, degraded: false });
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather: fakeGather(), mint: fakeMint().mint }, NOW);

    expect(result).toMatchObject({ status: 'composed', voiced: true });
    expect(upsertWeekPlan).toHaveBeenCalledWith(
      db,
      // summary is the deterministic-fallback field = voice.weekFraming.
      expect.objectContaining({ summary: VOICE.weekFraming, voice: VOICE }),
    );
  });

  it('degrades to no voice — but still persists the plan — when the voice stage fails', async () => {
    asMock(hasWeekPlan).mockResolvedValue(false);
    asMock(composeWeekVoice).mockResolvedValue({ voice: null, degraded: true });
    const { db } = fakeDb();

    const result = await runWeekPlanForFamily(FAMILY, db, { client: {} as never, gather: fakeGather(), mint: fakeMint().mint }, NOW);

    expect(result).toMatchObject({ status: 'composed', voiced: false });
    expect(upsertWeekPlan).toHaveBeenCalledWith(db, expect.objectContaining({ summary: null, voice: null }));
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
 * The composer runs the day BEFORE the parent's VIL-216 send moment.
 * weeklyPlanWeekday is identity (0=Sun…6=Sat, never 7). A Monday-start week
 * sends Monday, so compose runs SUNDAY; a Sunday-start week (the product
 * default) sends Sunday, so compose runs Saturday. Slot is one hour at the
 * parent's weekly_plan_send_time — asserted from first principles across DST
 * + offset zones + the per-parent send time, never read back from the function.
 */
describe('isComposeMoment — the family-local compose slot (day before the send moment)', () => {
  it('matches Sunday from the send time through <60 min later (Monday-start week)', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 8, 0, TZ), TZ, 1)).toBe(true); // Sun 08:00
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 8, 59, TZ), TZ, 1)).toBe(true); // +59
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 7, 59, TZ), TZ, 1)).toBe(false); // 1 early
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 9, 0, TZ), TZ, 1)).toBe(false); // +60
  });

  it('does NOT fire on the SEND day (Monday) — that is B2 delivery, not compose', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 7, 27, 8, 0, TZ), TZ, 1)).toBe(false); // Monday
  });

  it('honors the parent per-parent weekly_plan_send_time', () => {
    const p = prefs({ weeklyPlanSendTime: '09:00:00' });
    expect(isComposeMoment(p, zoned(2026, 7, 26, 9, 15, TZ), TZ, 1)).toBe(true); // Sun 08:15
    expect(isComposeMoment(p, zoned(2026, 7, 26, 8, 0, TZ), TZ, 1)).toBe(false); // default time no longer matches
  });

  it('reads the offset live across DST (winter EST) and catches a :45 zone', () => {
    expect(isComposeMoment(prefs(), zoned(2026, 2, 1, 8, 0, TZ), TZ, 1)).toBe(true); // Sun 08:00 EST
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 8, 15, 'Asia/Kathmandu'), 'Asia/Kathmandu', 1)).toBe(true);
  });

  it('shifts the compose day with the parent week-start (Sunday-start → compose Saturday)', () => {
    // weekStartDay 0 → send Sunday (weeklyPlanWeekday(0)=0) → compose Saturday.
    expect(isComposeMoment(prefs(), zoned(2026, 7, 25, 8, 0, TZ), TZ, 0)).toBe(true); // Saturday
    expect(isComposeMoment(prefs(), zoned(2026, 7, 26, 8, 0, TZ), TZ, 0)).toBe(false); // Sunday
  });
});
