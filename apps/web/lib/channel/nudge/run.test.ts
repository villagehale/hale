import { schema } from '@hale/db';
import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import type { RadarCandidate } from '~/lib/channel/intake/radar-decide';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { DailyOutlook } from '~/lib/weather/open-meteo';
import { NUDGE_OPT_OUT } from './nudge-voice.js';
import {
  type NudgeChildRow,
  type NudgeFamily,
  type NudgeRunDeps,
  defaultNudgeRunDeps,
  f14EnabledFor,
  isNudgeSlot,
  runNudgeCron,
} from './run.js';

/**
 * VIL-239 · M4 — the hourly sweep.
 *
 * Everything the sweep must never do, proved against Fakes (no DB, no provider, no
 * model):
 *
 *   - it does not run at all unless the F14 flag or the allowlist says so (D21);
 *   - it never sends without an `allowed: true` verdict from the outbound gate;
 *   - a second cron fire in the same hour sends NOTHING a second time;
 *   - a family with nothing worth saying gets silence AND an audit row, so a quiet
 *     week is a measured outcome rather than an absence of data;
 *   - a message that never went out never consumes the family's weekly budget.
 */

const FRIDAY_10AM = new Date('2026-07-31T14:00:00.000Z'); // 10:00 in Toronto (EDT)
const TZ = 'America/Toronto';
const SATURDAY = '2026-08-01';
const SUNDAY = '2026-08-02';

function family(overrides: Partial<NudgeFamily> = {}): NudgeFamily {
  return {
    familyId: 'fam-1',
    parentUserId: 'user-1',
    areaCoarse: 'L4C',
    timeZone: TZ,
    provisionedAt: new Date('2026-07-29T14:00:00.000Z'), // 48h before
    ...overrides,
  };
}

function candidate(overrides: Partial<RadarCandidate> = {}): RadarCandidate {
  return {
    id: 'cand-1',
    title: 'Library story time',
    venueName: 'Richmond Hill Library',
    ageRange: null,
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    eventDate: null,
    seasons: null,
    childId: null,
    confidence: 0.8,
    ...overrides,
  };
}

function win(overrides: Partial<RegistrationWindow> = {}): RegistrationWindow {
  return {
    id: 'w-1',
    municipality: 'richmond_hill' as Municipality,
    programDomain: 'rec_program' as ProgramDomain,
    cycleLabel: 'Fall 2026',
    ageMinMonths: 36,
    ageMaxMonths: 72,
    openAt: new Date('2026-08-04T14:30:00.000Z'),
    residentOpenAt: null,
    closesAt: null,
    sourceUrl: null,
    notes: null,
    createdAt: FRIDAY_10AM,
    updatedAt: FRIDAY_10AM,
    ...overrides,
  } as RegistrationWindow;
}

/** 6 months old on FRIDAY_10AM — squarely inside M8's 6-month checkpoint. */
const SIX_MONTH_OLD: NudgeChildRow[] = [
  { id: 'child-1', name: 'Maya', dateOfBirth: '2026-01-31', dobPrecision: 'derived' },
];

/** 15 years old — inside the 14-to-16 checkpoint, and never nameable (rule #1). */
const TEEN_ONLY: NudgeChildRow[] = [
  { id: 'teen-1', name: 'Ava', dateOfBirth: '2011-03-04', dobPrecision: 'derived' },
];

const WET: DailyOutlook[] = [
  { date: SATURDAY, precipitationChancePct: 95, highTempC: 18 },
  { date: SUNDAY, precipitationChancePct: 95, highTempC: 18 },
];

/** The Friday after {@link FRIDAY_10AM}, and its washed-out weekend. */
const NEXT_FRIDAY_10AM = new Date('2026-08-07T14:00:00.000Z');
const NEXT_WEEK_WET: DailyOutlook[] = [
  { date: '2026-08-08', precipitationChancePct: 95, highTempC: 18 },
  { date: '2026-08-09', precipitationChancePct: 95, highTempC: 18 },
];

interface Harness {
  deps: NudgeRunDeps;
  transport: FakeTransport;
  writes: Array<{ table: unknown; payload: Record<string, unknown> }>;
  dedupeKeys: Set<string>;
  /** MEM-10 · every open-loops promise this sweep tried to close. */
  closed: Array<{ familyId: string; kind: string; channelMessageId: string | null }>;
  /** Every health nudge that offered to register its own standing question. */
  offers: Array<{ ref: string; channelMessageId: string | null }>;
  /** Every nudge that landed in the parent's own text thread (lib/channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
}

function harness(
  options: {
    families?: NudgeFamily[];
    candidates?: RadarCandidate[];
    windows?: RegistrationWindow[];
    weather?: DailyOutlook[];
    enrolled?: boolean;
    consented?: boolean;
    recentSends?: number;
    transport?: FakeTransport;
    children?: NudgeChildRow[];
    doneCheckpoints?: Set<string>;
    claimedWindowIds?: Set<string>;
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const dedupeKeys = new Set<string>();
  const closed: Harness['closed'] = [];
  const offers: Harness['offers'] = [];
  const threaded: Harness['threaded'] = [];
  const transport = options.transport ?? new FakeTransport();

  const deps: NudgeRunDeps = {
    selectFamilies: async () => options.families ?? [family()],
    // 36 months: deliberately inside the registration window under test and OUTSIDE
    // every M8 health checkpoint band, so these M4 cases keep testing M4.
    loadChildren: async () =>
      options.children ?? [
        { id: 'child-1', name: 'Maya', dateOfBirth: '2023-07-31', dobPrecision: 'derived' },
      ],
    loadCandidates: async () => options.candidates ?? [],
    loadWindows: async () => options.windows ?? [],
    // Mirrors prod: the suppression set is the union of what the family was already
    // TOLD (read back off the ledger the sweep itself writes) and what they said is
    // DONE. Faking only the latter would hide the fall-through this feature depends on.
    loadSuppressedCheckpoints: async (_db, familyId) => {
      const prefix = `nudge:${familyId}:health:`;
      const told = [...dedupeKeys]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
      return new Set([...told, ...(options.doneCheckpoints ?? [])]);
    },
    loadClaimedWindowIds: async () => options.claimedWindowIds ?? new Set<string>(),
    weather: { getDailyOutlook: async () => options.weather ?? [] },
    buildGate: () => ({
      channelEnrolled: async () => options.enrolled ?? true,
      watchConsentGranted: async () => options.consented ?? true,
      countProactiveSends: async () => options.recentSends ?? 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () => TZ,
    }),
    dedupeActive: async (_db, key) => dedupeKeys.has(key),
    resolveSendablePhone: async () => '+14165550100',
    recordSend: async (_db, write) => {
      writes.push({ table: schema.channelMessages, payload: write as unknown as Record<string, unknown> });
      dedupeKeys.add(write.dedupeKey);
      return `msg-${writes.length}`;
    },
    audit: async (_db, row) => {
      writes.push({ table: schema.auditLog, payload: row as unknown as Record<string, unknown> });
    },
    transport,
    client: null,
    // MEM-10 · the ledger seam. Recorded rather than executed: the real writer's own
    // contract is unit-tested in lib/commitments/ledger.test.ts, and what this sweep
    // owes is that it calls it, once, with the message that made good.
    fulfillCommitment: async (_db, input) => {
      closed.push({
        familyId: input.familyId,
        kind: input.kind,
        channelMessageId: input.channelMessageId,
      });
      return { status: 'none_open' };
    },
    // The offer half of the same seam, recorded rather than executed for the same reason.
    recordCheckupOffer: async (_db, input) => {
      offers.push({ ref: input.ref, channelMessageId: input.channelMessageId });
      return { status: 'not_an_offer' };
    },
    threadMessage: async (_db, input) => {
      threaded.push(input);
      return 'conv-1';
    },
  };

  return { deps, transport, writes, dedupeKeys, closed, offers, threaded };
}

function db() {
  return {} as never;
}

function auditActions(writes: Harness['writes']): string[] {
  return writes
    .filter((w) => w.table === schema.auditLog)
    .map((w) => String(w.payload.actionTaken));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the D21 dark-launch flag', () => {
  it('reads F14_ENABLED strictly, so a stored trailing newline stays OFF', () => {
    vi.stubEnv('F14_ENABLED', 'true\n');
    expect(f14EnabledFor('fam-1')).toBe(false);
    vi.stubEnv('F14_ENABLED', 'true');
    expect(f14EnabledFor('fam-1')).toBe(true);
  });

  it('lets a named family through while the flag is off', () => {
    vi.stubEnv('F14_ENABLED', 'false');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-9, fam-1 ,fam-3');
    expect(f14EnabledFor('fam-1')).toBe(true);
    expect(f14EnabledFor('fam-2')).toBe(false);
  });

  it('does no work at all when neither the flag nor the allowlist is set', async () => {
    const h = harness({ windows: [win()] });
    const selectFamilies = vi.fn(async () => [family()]);
    const result = await runNudgeCron(db(), { ...h.deps, selectFamilies }, FRIDAY_10AM);
    expect(result).toMatchObject({ enabled: false, evaluated: 0, sent: 0 });
    expect(selectFamilies).not.toHaveBeenCalled();
    expect(h.transport.sent).toHaveLength(0);
  });

  it('skips a family that is not in the allowlist while the flag is off', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', 'fam-other');
    const h = harness({ windows: [win()] });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result.evaluated).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('the local send slot', () => {
  it('matches the whole hour, not one minute of it', () => {
    expect(isNudgeSlot(new Date('2026-07-31T14:00:00.000Z'), TZ)).toBe(true);
    expect(isNudgeSlot(new Date('2026-07-31T14:59:00.000Z'), TZ)).toBe(true);
    expect(isNudgeSlot(new Date('2026-07-31T15:00:00.000Z'), TZ)).toBe(false);
    expect(isNudgeSlot(new Date('2026-07-31T13:59:00.000Z'), TZ)).toBe(false);
  });

  it('is the parent’s own morning, not the server’s', () => {
    // The same instant is 10:00 in Toronto and 07:00 in Vancouver.
    expect(isNudgeSlot(FRIDAY_10AM, 'America/Vancouver')).toBe(false);
    expect(isNudgeSlot(FRIDAY_10AM, TZ)).toBe(true);
  });

  it('leaves a family outside their slot alone', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    const result = await runNudgeCron(db(), h.deps, new Date('2026-07-31T18:00:00.000Z'));
    expect(result.evaluated).toBe(0);
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('runNudgeCron — sending', () => {
  it('sends one text carrying the nudge and the opt-out line', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ enabled: true, evaluated: 1, sent: 1, quiet: 0 });
    expect(h.transport.sent).toHaveLength(1);
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain('Richmond Hill');
    expect(body).toContain('Fall 2026');
    expect(body).toContain('Maya');
    expect(body.endsWith(NUDGE_OPT_OUT)).toBe(true);
  });

  it('writes ONE channel_messages row and its audit row (rule #6)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      familyId: 'fam-1',
      parentUserId: 'user-1',
      channel: 'sms',
      category: 'nudge',
      status: 'queued',
    });
    expect(auditActions(h.writes)).toContain('proactive_nudge_sent');
  });

  it('stores no rendered body on the outbound row (rule #1)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    const ledger = h.writes.find((w) => w.table === schema.channelMessages);
    expect(ledger?.payload.body).toBeUndefined();
  });

  it('sends a weather swap when there is no registration date', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ candidates: [candidate()], weather: WET });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain('Library story time');
  });

  it('records the cohort so a first nudge is tellable from the weekly rhythm', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const fresh = harness({ windows: [win()] });
    await runNudgeCron(db(), fresh.deps, FRIDAY_10AM);
    const freshAudit = fresh.writes.find((w) => w.table === schema.auditLog);
    expect(freshAudit?.payload.after).toMatchObject({ cohort: 'onboarding_48h' });

    const settled = harness({
      windows: [win()],
      families: [family({ provisionedAt: new Date('2026-06-01T14:00:00.000Z') })],
    });
    await runNudgeCron(db(), settled.deps, FRIDAY_10AM);
    const settledAudit = settled.writes.find((w) => w.table === schema.auditLog);
    expect(settledAudit?.payload.after).toMatchObject({ cohort: 'weekly_rhythm' });
  });
});

/**
 * VIL-242 · M7 — the sweep must ask whether a registration window has already been
 * taken over by a sequence before it announces it. The unit test on decideNudge proves
 * the decision; this one proves the sweep actually LOADS the claims, which is the half
 * that silently regresses.
 */
describe('runNudgeCron — deferring to an M7 sequence', () => {
  it('sends nothing about a window an M7 sequence has claimed', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], claimedWindowIds: new Set(['w-1']) });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
  });

  it('still sends a weekend swap to a family whose registration date is claimed', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      claimedWindowIds: new Set(['w-1']),
      candidates: [candidate()],
      weather: WET,
    });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(h.transport.bodies()[0]).toContain('Library story time');
  });
});

describe('runNudgeCron — the outbound gate', () => {
  it('sends nothing to a family that pressed STOP', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], enrolled: false });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result.sent).toBe(0);
    expect(result.held.not_enrolled).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  it('sends nothing to a family that never agreed to be watched', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], consented: false });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result.held.no_watch_consent).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('sends nothing to a family already nudged this week', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], recentSends: 1 });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(result.held.frequency_cap).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('never composes for a gated family — no model spend behind a closed gate', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], enrolled: false });
    const loadCandidates = vi.fn(async () => []);
    await runNudgeCron(db(), { ...h.deps, loadCandidates }, FRIDAY_10AM);
    expect(loadCandidates).not.toHaveBeenCalled();
  });
});

describe('runNudgeCron — idempotency', () => {
  it('sends once across two cron fires in the same slot', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    const first = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    const second = await runNudgeCron(db(), h.deps, new Date('2026-07-31T14:30:00.000Z'));

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.deduped).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('keys a registration nudge to the window, and a swap to the week', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const registration = harness({ windows: [win()] });
    await runNudgeCron(db(), registration.deps, FRIDAY_10AM);
    expect([...registration.dedupeKeys][0]).toBe('nudge:fam-1:registration:w-1');

    const swap = harness({ candidates: [candidate()], weather: WET });
    await runNudgeCron(db(), swap.deps, FRIDAY_10AM);
    expect([...swap.dedupeKeys][0]).toBe('nudge:fam-1:weather_swap:2026-07-27');
  });

  /**
   * MEM-10 · this sweep is what makes the intake radar's "your first weekend find lands
   * in a day or two" true, so a send is what pays that promise off — against the row
   * that carried it, and never against a compose.
   */
  it('closes the first-find promise with the message that kept it', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });

    await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(h.closed).toEqual([
      { familyId: 'fam-1', kind: 'first_find', channelMessageId: 'msg-1' },
    ]);
  });

  it('owes nothing new to a family it had nothing to say to', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness();

    await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    // A quiet family's promise stays open on purpose: the debt is real until a message
    // actually lands, and closing it here is exactly the lie the ledger exists to stop.
    expect(h.closed).toEqual([]);
  });
});

describe('runNudgeCron — silence', () => {
  it('says nothing and records that it looked', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness();
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ evaluated: 1, sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
    expect(h.writes.filter((w) => w.table === schema.channelMessages)).toHaveLength(0);
    const audit = h.writes.find((w) => w.table === schema.auditLog);
    expect(audit?.payload.actionTaken).toBe('proactive_nudge_skipped');
    expect(audit?.payload.after).toMatchObject({ reason: 'nothing_worth_saying' });
  });

  it('suggests no weekend to a household whose only children are 13+ (rule #1)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // Toronto-less area + a done checkpoint leaves nothing but the weekend on the
    // table, and the weekend is exactly what a teen-only household never gets.
    const h = harness({
      candidates: [candidate()],
      weather: WET,
      children: TEEN_ONLY,
      doneCheckpoints: new Set(['immunization_14_to_16_years:teen-1:0']),
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('runNudgeCron — the prod send path (VIL-260)', () => {
  it('wires the real Twilio transport into the default deps', async () => {
    // VIL-262 made the dep non-nullable, so "a transport is wired" is now a type-level
    // fact. What is still worth asserting is WHICH one: the REAL outbound leg, which
    // refuses by naming its missing credentials rather than silently reporting a send
    // nobody made.
    const { transport, threadMessage } = defaultNudgeRunDeps();
    // And WHICH threader: a port declared but wired to a stub is the same silent
    // no-op the port exists to forbid (rule #11).
    expect(threadMessage).toBe(threadProactiveMessage);
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    await expect(
      transport.send({ to: '+14165550100', body: 'never leaves: no credentials' }),
    ).rejects.toThrow(/twilio not configured/);
  });

  it('writes the ledger row and the audit row for the nudge it sent', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result.sent).toBe(1);
    expect(h.transport.sent).toHaveLength(1);
    const ledger = h.writes.filter((w) => w.table === schema.channelMessages);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.payload).toMatchObject({
      channel: 'sms',
      category: 'nudge',
      status: 'queued',
      templateKey: 'proactive_nudge:registration',
      dedupeKey: 'nudge:fam-1:registration:w-1',
    });
    expect(auditActions(h.writes)).toContain('proactive_nudge_sent');
  });

  it("puts the nudge in the parent's own text thread, so their reply has an antecedent", async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()] });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    // A nudge the coach cannot see is a nudge the parent answers into silence: prod on
    // 2026-08-22 had two of these, and the parent's "yes" landed on whatever else was
    // standing. `channel_messages` stores no body (rule #1), so `messages` is the only
    // place a reply can find what it is replying to.
    expect(h.threaded).toHaveLength(1);
    expect(h.threaded[0]).toMatchObject({ familyId: 'fam-1', parentUserId: 'user-1' });
    expect(h.transport.bodies()[0]).toContain(h.threaded[0]?.body ?? '\u0000');
  });

  it('threads the composed sentence, never the CASL footer on the wire', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // A first send of the period carries the opt-out line; the thread must not, or the
    // coach re-reads "Reply STOP to opt out" as something Hale said to the parent.
    const h = harness({ windows: [win()] });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    const wire = h.transport.bodies()[0] ?? '';
    expect(wire).toMatch(/STOP/i);
    expect(h.threaded[0]?.body).not.toMatch(/STOP/i);
    // ...and it is still the real sentence, not an empty string that trivially passes.
    expect(wire).toContain(h.threaded[0]?.body ?? '\u0000');
  });
});

/**
 * VIL-262 — the reader the sweep sends through carries the whole predicate.
 *
 * There were two readers that resolved a parent's number, and the weaker one (no
 * `verified_at IS NOT NULL`) was the one this sweep used. Nothing went wrong only
 * because the gate's enrolment check happened to run BEFORE it — correctness that
 * lives in the call order is correctness one refactor away from being gone.
 *
 * So these cases delete the ordering protection on purpose: the gate is told the
 * parent is enrolled and consenting, which is the state a stale or reordered check
 * would produce, and the reader must still refuse. Nothing about the outcome may
 * depend on what ran first.
 */
describe('runNudgeCron — the send-side reader (VIL-262)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');

  /** Just enough of a Drizzle handle for the reader's one indexed read — and it hands
   * the row back REGARDLESS of the predicate, so what refuses below is the reader's
   * own check on the columns, not a WHERE clause a fake cannot execute. */
  function channelDb(row: Record<string, unknown>) {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    } as never;
  }

  it.each([
    ['unverified', { verifiedAt: null, revokedAt: null }],
    ['revoked — the parent texted STOP', { verifiedAt: FRIDAY_10AM, revokedAt: FRIDAY_10AM }],
  ])('texts nothing to a %s channel, with the gate saying enrolled', async (_label, state) => {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    const h = harness({ windows: [win()], enrolled: true, consented: true });
    const { resolveSendablePhone } = defaultNudgeRunDeps();

    const result = await runNudgeCron(
      channelDb({ phoneE164Encrypted: encryptString('+14165550100'), ...state }),
      { ...h.deps, resolveSendablePhone },
      FRIDAY_10AM,
    );

    expect(h.transport.sent).toEqual([]);
    expect(result.sent).toBe(0);
    // Loudly, not quietly: no number for a parent the gate cleared is a contradiction,
    // and a swept-under skip would read as a family with nothing worth saying.
    expect(result.failed).toBe(1);
  });
});

describe('runNudgeCron — failure isolation', () => {
  it('keeps sweeping after one family throws', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      families: [family(), family({ familyId: 'fam-2', parentUserId: 'user-2' })],
    });
    let call = 0;
    const loadChildren: NudgeRunDeps['loadChildren'] = async (database, familyId) => {
      call += 1;
      if (call === 1) throw new Error('boom');
      return h.deps.loadChildren(database, familyId);
    };
    const result = await runNudgeCron(db(), { ...h.deps, loadChildren }, FRIDAY_10AM);

    expect(result.evaluated).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});

/**
 * VIL-243 · M8 — the health-admin checkpoint, riding the SAME pipeline.
 *
 * The point of these cases is that M8 added a message CLASS, not a channel: it competes
 * for the one weekly slot the outbound gate grants a family, it loses to a registration
 * deadline, and it obeys the same dedupe and the same rule #1.
 */
describe('runNudgeCron — health checkpoints (M8)', () => {
  it('sends the static checkpoint copy, named, linked and reply-able', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ children: SIX_MONTH_OLD });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 1, quiet: 0 });
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain('Maya:');
    expect(body).toContain('a visit at 6 months');
    expect(body).toContain('https://www.ontario.ca/page/ontarios-routine-immunization-schedule');
    expect(body).toContain('Done, or want a reminder next week?');
    expect(body.endsWith(NUDGE_OPT_OUT)).toBe(true);
  });

  it('never runs the voice model for health copy', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ children: SIX_MONTH_OLD });
    // A client that throws the moment it is touched: health copy is static, always.
    const client = new Proxy(
      {},
      {
        get() {
          throw new Error('health copy must never reach the model');
        },
      },
    ) as NudgeRunDeps['client'];
    const result = await runNudgeCron(db(), { ...h.deps, client }, FRIDAY_10AM);
    expect(result.sent).toBe(1);
  });

  it('loses to a registration deadline, and beats a weekend suggestion', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const beaten = harness({ children: SIX_MONTH_OLD, windows: [win({ ageMinMonths: 0 })] });
    await runNudgeCron(db(), beaten.deps, FRIDAY_10AM);
    expect(beaten.transport.bodies()[0]).toContain('Fall 2026');

    const wins = harness({ children: SIX_MONTH_OLD, candidates: [candidate()], weather: WET });
    await runNudgeCron(db(), wins.deps, FRIDAY_10AM);
    expect(wins.transport.bodies()[0]).toContain('a visit at 6 months');
  });

  it('keys the send to the child and the run of the checkpoint', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ children: SIX_MONTH_OLD });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect([...h.dedupeKeys]).toEqual(['nudge:fam-1:health:immunization_6_months:child-1:0']);
  });

  it('sends once across two cron fires in the same slot', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ children: SIX_MONTH_OLD });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    const second = await runNudgeCron(db(), h.deps, new Date('2026-07-31T14:30:00.000Z'));

    expect(second.sent).toBe(0);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('still refuses at the send guard when selection has not caught up', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // Selection now drops a checkpoint the family was already told about, so the
    // send-time dedupe guard is no longer the thing that stops the second fire. It is
    // still the backstop for the race it was built for — two invocations overlapping
    // before the ledger row is visible to the next read — so it is pinned separately
    // rather than left to be proven by a path that no longer reaches it.
    const h = harness({ children: SIX_MONTH_OLD });
    const blind: NudgeRunDeps = { ...h.deps, loadSuppressedCheckpoints: async () => new Set() };

    await runNudgeCron(db(), blind, FRIDAY_10AM);
    const second = await runNudgeCron(db(), blind, new Date('2026-07-31T14:30:00.000Z'));

    expect(second).toMatchObject({ sent: 0, deduped: 1 });
    expect(h.transport.sent).toHaveLength(1);
  });

  it('yields the slot to the next class once its checkpoint has been sent', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // A health window is months wide, so a checkpoint that stayed the top candidate
    // after it had already been sent would dead-end the sweep on the dedupe guard and
    // silence every other nudge class for the whole band — up to three years for the
    // 4-to-6-year row. Being told once is the design; being told once and then muted
    // is not.
    const h = harness({
      children: SIX_MONTH_OLD,
      candidates: [candidate()],
      weather: [...WET, ...NEXT_WEEK_WET],
    });

    const first = await runNudgeCron(db(), h.deps, FRIDAY_10AM);
    expect(first.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain('a visit at 6 months');

    const second = await runNudgeCron(db(), h.deps, NEXT_FRIDAY_10AM);
    expect(second).toMatchObject({ sent: 1, deduped: 0 });
    expect(h.transport.bodies()[1]).toContain('Library story time');
  });

  it('competes for the SAME weekly slot as every other nudge', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // recentSends = a nudge of any class already landed this week. The health nudge is
    // held, not queued: a household is one audience with one weekly budget.
    const h = harness({ children: SIX_MONTH_OLD, recentSends: 1 });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result.held.frequency_cap).toBe(1);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('sends nothing to a family that pressed STOP or never opted into watching', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const stopped = harness({ children: SIX_MONTH_OLD, enrolled: false });
    expect((await runNudgeCron(db(), stopped.deps, FRIDAY_10AM)).held.not_enrolled).toBe(1);
    expect(stopped.transport.sent).toHaveLength(0);

    const unwatched = harness({ children: SIX_MONTH_OLD, consented: false });
    expect((await runNudgeCron(db(), unwatched.deps, FRIDAY_10AM)).held.no_watch_consent).toBe(1);
    expect(unwatched.transport.sent).toHaveLength(0);
  });

  it('goes quiet on a checkpoint the parent already said was done', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      children: SIX_MONTH_OLD,
      doneCheckpoints: new Set(['immunization_6_months:child-1:0']),
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
  });

  it('tells a 13+ household the ADMIN task and never the specifics (rule #1)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ children: TEEN_ONLY });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result.sent).toBe(1);
    const body = h.transport.bodies()[0] as string;
    expect(body).toContain('Your teen:');
    expect(body).toContain('A routine vaccine record check is due');
    // The name never leaves the building, and neither does anything clinical.
    expect(body).not.toContain('Ava');
    expect(body.toLowerCase()).not.toMatch(/\b(dose|booster|shot|hpv|hepatitis)\b/);
  });

  it('says nothing outside Ontario, where none of this content applies', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      children: SIX_MONTH_OLD,
      families: [family({ areaCoarse: 'V6B' })],
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
  });

  /**
   * VIL-260 · WS1 — the ±6-month early-edge slack is what a DERIVED date of birth
   * earns. The sweep used to stamp every child 'derived' regardless of what the row
   * says, which hands a parent who typed an exact birthday the same fuzziness as one
   * who said "about three" — and admits their child to a window they are not in yet.
   */
  it('reads the slack off the stored dob_precision instead of assuming derived', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    // 44 months on FRIDAY_10AM: past every band that ends before 48, and inside the
    // 48-month bands ONLY via the derived early-edge slack.
    const child = { id: 'child-1', name: 'Nina', dateOfBirth: '2022-11-30' };

    const derived = harness({ children: [{ ...child, dobPrecision: 'derived' }] });
    expect(await runNudgeCron(db(), derived.deps, FRIDAY_10AM)).toMatchObject({ sent: 1 });
    expect(derived.transport.bodies()[0]).toContain('Nina:');

    const exact = harness({ children: [{ ...child, dobPrecision: 'exact' }] });
    expect(await runNudgeCron(db(), exact.deps, FRIDAY_10AM)).toMatchObject({ sent: 0, quiet: 1 });
    expect(exact.transport.sent).toHaveLength(0);
  });
});
