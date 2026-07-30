import { schema } from '@hale/db';
import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { RadarCandidate } from '~/lib/channel/intake/radar-decide';
import type { DailyOutlook } from '~/lib/weather/open-meteo';
import { NUDGE_OPT_OUT } from './nudge-voice.js';
import {
  type NudgeFamily,
  type NudgeRunDeps,
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

const WET: DailyOutlook[] = [
  { date: SATURDAY, precipitationChancePct: 95, highTempC: 18 },
  { date: SUNDAY, precipitationChancePct: 95, highTempC: 18 },
];

interface Harness {
  deps: NudgeRunDeps;
  transport: FakeTransport;
  writes: Array<{ table: unknown; payload: Record<string, unknown> }>;
  dedupeKeys: Set<string>;
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
    transport?: FakeTransport | null;
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const dedupeKeys = new Set<string>();
  const transport = options.transport === undefined ? new FakeTransport() : options.transport;

  const deps: NudgeRunDeps = {
    selectFamilies: async () => options.families ?? [family()],
    loadChildren: async () => [
      { id: 'child-1', name: 'Maya', dateOfBirth: '2022-07-31' },
    ],
    loadCandidates: async () => options.candidates ?? [],
    loadWindows: async () => options.windows ?? [],
    weather: { getDailyOutlook: async () => options.weather ?? [] },
    buildGate: () => ({
      channelEnrolled: async () => options.enrolled ?? true,
      watchConsentGranted: async () => options.consented ?? true,
      countProactiveSends: async () => options.recentSends ?? 0,
      parentTimeZone: async () => TZ,
    }),
    dedupeActive: async (_db, key) => dedupeKeys.has(key),
    resolveSendTarget: async () => '+14165550100',
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
  };

  return { deps, transport: transport ?? new FakeTransport(), writes, dedupeKeys };
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
      status: 'sent',
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

  it('says nothing to a household whose only children are 13+ (rule #1)', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ candidates: [candidate()], weather: WET });
    const loadChildren: NudgeRunDeps['loadChildren'] = async () => [
      { id: 'teen-1', name: 'Ava', dateOfBirth: '2011-03-04' },
    ];
    const result = await runNudgeCron(db(), { ...h.deps, loadChildren }, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('runNudgeCron — no transport yet (VIL-214)', () => {
  it('composes but sends nothing, and does not consume the family’s weekly budget', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({ windows: [win()], transport: null });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM);

    expect(result).toMatchObject({ sent: 0, composed: 1 });
    expect(h.writes.filter((w) => w.table === schema.channelMessages)).toHaveLength(0);
    expect(h.dedupeKeys.size).toBe(0);
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
