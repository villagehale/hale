import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeekdayCareContext } from '~/lib/care/weekday';
import type { FamilyTextRecipient } from '~/lib/channel/family-recipients';
import type { ParentCallNameState } from '~/lib/channel/identity/parent-call-name';
import type { RadarCandidate } from '~/lib/channel/intake/radar-decide';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type OpsPage, pageOps } from '~/lib/monitoring/failure-page';
import { emptyHouseholdFindBias } from '~/lib/reviews/household-bias';
import type { DailyOutlook } from '~/lib/weather/open-meteo';
import {
  type NudgeUnwrittenReason,
  type NudgeWrite,
  nudgeModelOnlyEnabled,
  writeNudgeModelOnly,
} from './model-only';
import { NUDGE_OPT_OUT, nudgeFactSlots } from './nudge-voice';
import {
  MAX_UNDATED_ASK_FAILURES,
  type NudgeChildRow,
  type NudgeFamily,
  type NudgeModelOnlyDeps,
  type NudgeRunDeps,
  countRecentAskFailures,
  defaultNudgeModelOnlyDeps,
  runNudgeCron,
} from './run';
import type { SaturdayPlans } from './saturday-plans';

vi.mock('~/lib/channel/linq/family-outbound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/channel/linq/family-outbound')>()),
  familySpeechLanguage: async () => 'en',
}));

/** A skill that cannot be loaded, switched on per test: the real loader otherwise. */
const skillLoad = vi.hoisted(() => ({ fail: false }));
vi.mock('~/lib/cron/skill', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/cron/skill')>();
  const guarded = <T>(load: () => Promise<T>) => {
    if (skillLoad.fail) throw new Error('skill missing');
    return load();
  };
  return {
    ...real,
    loadCronSkill: async (name: string) => guarded(() => real.loadCronSkill(name)),
    loadNudgeVoiceSkill: async () => guarded(() => real.loadNudgeVoiceSkill()),
  };
});

/**
 * NUDGE_MODEL_ONLY_ENABLED at the sweep: with the flag on, a nudge the model cannot write
 * sends nothing, is named, pages #ops once and is tried again at the next slot. With it
 * off, every kind does what main does, fixed sentence included. run.test.ts is main's
 * suite, unmodified, and is the rest of the flag-off proof.
 */

/** The model's turn, for a sweep test about everything AROUND the words: it answers with
 * the decision's facts. The two kinds whose writing has its own tests go to the real
 * writer, which is silent without a client. */
const factNudgeWriter: typeof writeNudgeModelOnly = async (nudge, deps): Promise<NudgeWrite> => {
  if (nudge.kind === 'weekday_care' || nudge.kind === 'empty_saturday') {
    return writeNudgeModelOnly(nudge, deps);
  }
  return { message: nudgeFactSlots(nudge).join(' ') };
};

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
    source: null,
    sourceUrl: null,
    access: null,
    whenLabel: null,
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

const WET: DailyOutlook[] = [
  { date: SATURDAY, precipitationChancePct: 95, highTempC: 18 },
  { date: SUNDAY, precipitationChancePct: 95, highTempC: 18 },
];

interface Harness {
  deps: NudgeRunDeps;
  modelOnly: NudgeModelOnlyDeps;
  transport: FakeTransport;
  writes: Array<{ table: unknown; payload: Record<string, unknown> }>;
  dedupeKeys: Set<string>;
  /** MEM-10 · every open-loops promise this sweep tried to close. */
  closed: Array<{ familyId: string; kind: string; channelMessageId: string | null }>;
  /** Every health nudge that offered to register its own standing question. */
  offers: Array<{ ref: string; channelMessageId: string | null }>;
  /** Every nudge that landed in the parent's own text thread (lib/channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  /** Every #ops page, exactly as it would leave. */
  pages: OpsPage[];
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
    /** VIL-360 — what this household has told Hale about its weekdays. */
    weekdayCare?: WeekdayCareContext;
    /** VIL-365 — default unread, so existing cases do not grow an empty-Saturday ask. */
    saturdayPlans?: SaturdayPlans;
    householdBias?: ReturnType<typeof emptyHouseholdFindBias>;
    /** The family's textable parent seats. One primary parent unless a test says
     * otherwise (channel/family-recipients.ts is the prod reader). */
    recipients?: FamilyTextRecipient[];
    /** Per-parent watch consent, for the households where the two seats differ. */
    consentedFor?: (parentUserId: string) => boolean;
    /** Per-parent enrolment, same reason. */
    enrolledFor?: (parentUserId: string) => boolean;
    /** Per-parent numbers, so a two-parent household's sends are tellable apart. */
    phones?: Record<string, string>;
    /**
     * Count the family's cap off THIS RUN'S OWN LEDGER WRITES, the way prod counts it
     * (outbound-gate.ts `countFamilyProactiveSends`), instead of the flat zero the rest
     * of this suite is written against.
     *
     * Opt-in rather than the default because it is a stricter world: prod's second cron
     * fire inside one slot is held by the CAP, not by the dedupe key, and the cases
     * below that pin the dedupe guard would stop reaching it. It is what makes the
     * two-parent cases real — with a flat zero, a sweep that sent to the first parent
     * before gating the second would pass them.
     */
    familyCapCountsLedger?: boolean;
    /** Default: this parent is already named, so a find does not grow a second text. */
    parentCallName?: ParentCallNameState;
    /** The model could not write the name ask this run. */
    nameAskUnwritten?: boolean;
    /** VIL-423 · the date check's reader factory. The default throws, so a read while
     * REGISTRATION_DATE_CHECK is off is a failure rather than a silent page fetch. */
    createDateReader?: NudgeRunDeps['createDateReader'];
    /** What the model does with this nudge. Default: it writes a line from the facts. */
    composeMessage?: NudgeModelOnlyDeps['composeMessage'];
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const dedupeKeys = new Set<string>();
  const closed: Harness['closed'] = [];
  const offers: Harness['offers'] = [];
  const threaded: Harness['threaded'] = [];
  const pages: OpsPage[] = [];
  const transport = options.transport ?? new FakeTransport();

  const deps: NudgeRunDeps = {
    selectFamilies: async () => options.families ?? [family()],
    /** SEAM: prod reads family_members ⋈ users ⋈ parent_channels
     * (channel/family-recipients.ts). The default is the ONE parent the fixture's own
     * family row names. */
    loadRecipients: async (_db, familyId) =>
      options.recipients ?? [
        {
          parentUserId:
            (options.families ?? [family()]).find((row) => row.familyId === familyId)
              ?.parentUserId ?? 'user-1',
          timeZone: TZ,
          role: 'primary_parent',
        },
      ],
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
    loadClaimedWindowIds: async () => options.claimedWindowIds ?? new Set<string>(),
    loadWeekdayCareContext: async () =>
      options.weekdayCare ?? { stated: [], askedBefore: false, weekendFindSent: false },
    loadSaturdayPlans: async () => options.saturdayPlans ?? 'unread',
    loadHouseholdBias: async () => options.householdBias ?? emptyHouseholdFindBias(),
    weather: { getDailyOutlook: async () => options.weather ?? [] },
    buildGate: () => ({
      channelEnrolled: async (parentUserId) =>
        options.enrolledFor?.(parentUserId) ?? options.enrolled ?? true,
      watchConsentGranted: async (parentUserId) =>
        options.consentedFor?.(parentUserId) ?? options.consented ?? true,
      countProactiveSends: async (familyId) =>
        options.recentSends ??
        (options.familyCapCountsLedger
          ? writes.filter(
              (write) =>
                write.table === schema.channelMessages &&
                write.payload.familyId === familyId &&
                write.payload.category === 'nudge',
            ).length
          : 0),
      proactiveSentSince: async () => false,
      parentTimeZone: async (parentUserId) =>
        (options.recipients ?? []).find((r) => r.parentUserId === parentUserId)?.timeZone ?? TZ,
    }),
    dedupeActive: async (_db, key) => dedupeKeys.has(key),
    resolveSendablePhone: async (_db, parentUserId) =>
      options.phones?.[parentUserId] ?? '+14165550100',
    recordSend: async (_db, write) => {
      writes.push({
        table: schema.channelMessages,
        payload: write as unknown as Record<string, unknown>,
      });
      dedupeKeys.add(write.dedupeKey);
      return `msg-${writes.length}`;
    },
    audit: async (_db, row) => {
      writes.push({ table: schema.auditLog, payload: row as unknown as Record<string, unknown> });
    },
    transport,
    client: null,
    // The model writes the name ask; the harness answers with a marker per kind so a
    // test can tell the open ask from the confirm without any fixed copy existing.
    composeNameAsk: async ({ ask }) =>
      options.nameAskUnwritten
        ? null
        : ask.kind === 'confirm'
          ? `NAME CONFIRM ${ask.first}`
          : 'NAME ASK',
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
    recordActivityOffers: async (_db, familyId, picks) => {
      for (const pick of picks)
        writes.push({ table: schema.familyActivityHistory, payload: { familyId, ...pick } });
      return [];
    },
    threadMessage: async (_db, input) => {
      threaded.push(input);
      return 'conv-1';
    },
    loadParentCallName: async () =>
      options.parentCallName ?? {
        needsName: false,
        alreadyAsked: false,
        googleGivenName: null,
      },
    createDateReader:
      options.createDateReader ??
      (() => {
        throw new Error('unexpected date read');
      }),
  };

  const modelOnly: NudgeModelOnlyDeps = {
    composeMessage: options.composeMessage ?? factNudgeWriter,
    page: async (_db, page) => {
      pages.push(page);
      return 'paged';
    },
    // Mirrors prod: the count is read back off the audit rows this sweep wrote. The
    // window itself is the pglite suite's subject; here every row is inside it.
    countAskFailures: async (_db, familyId, nudgeRef) =>
      writes.filter((write) => {
        const after = write.payload.after as { nudgeRef?: unknown } | undefined;
        return (
          write.table === schema.auditLog &&
          write.payload.familyId === familyId &&
          write.payload.actionTaken === 'proactive_nudge_unwritten' &&
          after?.nudgeRef === nudgeRef
        );
      }).length,
  };

  return { deps, modelOnly, transport, writes, dedupeKeys, closed, offers, threaded, pages };
}

/** The ledger rows of one text are written in one transaction; the fake runs it inline. */
function db() {
  const fake = {
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(fake),
    // Just enough for composeVoice to record its agent_runs row.
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'run-1' }] }) }),
  };
  return fake as never;
}

/** With every default-off flag on (CI's advisory job), these three stop or reroute a send
 * before the writer runs. Off here, so the writer's failure is what the test sees. */
function keepTheDirectSendPath() {
  vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.stubEnv('REGISTRATION_DATE_CHECK', 'off');
}

const failingWriter = (reason: NudgeUnwrittenReason = 'unusable') =>
  vi.fn<NudgeModelOnlyDeps['composeMessage']>(async () => ({ unwritten: reason }));

/**
 * A nudge with a date of its own has no count against it: it is tried at every slot, past
 * the point an undated ask would rest, and the slot its writer works is the one it sends.
 */
async function expectTriedEverySlot(h: Harness, composeMessage: ReturnType<typeof failingWriter>) {
  keepTheDirectSendPath();
  const failedSlots = MAX_UNDATED_ASK_FAILURES + 2;
  for (let slot = 1; slot <= failedSlots; slot += 1) {
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result).toMatchObject({ sent: 0, unwritten: 1, resting: 0 });
    expect(composeMessage).toHaveBeenCalledTimes(slot);
  }
  composeMessage.mockResolvedValue({ message: 'Written once the model was back.' });
  const back = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
  expect(back).toMatchObject({ sent: 1, unwritten: 0, resting: 0 });
  expect(h.transport.bodies()).toEqual(['Written once the model was back.']);
}

beforeEach(() => {
  vi.stubEnv('NUDGE_MODEL_ONLY_ENABLED', 'true');
  keepTheDirectSendPath();
});

afterEach(() => {
  vi.unstubAllEnvs();
  skillLoad.fail = false;
});

/**
 * Dec 1 rule 1: if the model cannot write it, send nothing and page #ops. The failure
 * reasons are stipulated here because this block is about the sweep's reaction; that
 * the real composer returns each of them is pinned in nudge-voice.test.ts.
 */
describe('runNudgeCron — a nudge the model could not write', () => {
  const REASONS = ['no_client', 'skill_load', 'model_failed', 'unusable'] as const;

  beforeEach(keepTheDirectSendPath);

  function ledgerRows(h: Harness) {
    return h.writes.filter((write) => write.table === schema.channelMessages);
  }

  function unwrittenRows(h: Harness) {
    return h.writes.filter(
      (write) =>
        write.table === schema.auditLog &&
        write.payload.actionTaken === 'proactive_nudge_unwritten',
    );
  }

  it.each(REASONS)('%s: sends nothing, audits it by name and pages #ops', async (reason) => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      composeMessage: async () => ({ unwritten: reason }),
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(result).toMatchObject({ sent: 0, quiet: 1, unwritten: 1, resting: 0, failed: 0 });
    expect(h.transport.sent).toEqual([]);
    expect(ledgerRows(h)).toEqual([]);
    expect(h.threaded).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(unwrittenRows(h)).toHaveLength(1);
    expect(unwrittenRows(h)[0]?.payload.familyId).toBe('fam-1');
    expect(unwrittenRows(h)[0]?.payload.after).toEqual({
      reason: 'unvoiced',
      kind: 'registration',
      unwritten: reason,
    });
    expect(h.pages).toEqual([{ site: 'nudge_unwritten', facts: { kind: 'registration', reason } }]);
  });

  it('carries no fact of the nudge on the page or the audit row', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      composeMessage: async () => ({ unwritten: 'unusable' }),
    });
    await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    const trail = JSON.stringify({
      page: h.pages,
      skip: unwrittenRows(h).map((row) => row.payload),
    });
    expect(trail).toContain('nudge_unwritten');
    for (const fact of ['Maya', 'Richmond Hill', 'Fall 2026', 'Aug']) {
      expect(trail).not.toContain(fact);
    }
  });

  it('a household with one parent held still names that hold', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      windows: [win()],
      recipients: [
        { parentUserId: 'user-1', timeZone: TZ, role: 'primary_parent' },
        { parentUserId: 'user-2', timeZone: TZ, role: 'co_parent' },
      ],
      consentedFor: (parentUserId) => parentUserId === 'user-1',
      composeMessage: async () => ({ unwritten: 'model_failed' }),
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result.unwritten).toBe(1);
    expect(result.held.no_watch_consent).toBe(1);
  });

  it.each(REASONS)(
    '%s: a registration nudge is tried at every slot and still goes',
    async (reason) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const composeMessage = failingWriter(reason);
      await expectTriedEverySlot(harness({ windows: [win()], composeMessage }), composeMessage);
    },
  );

  it('a weather swap is tried at every slot and still goes', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const composeMessage = failingWriter();
    const h = harness({
      candidates: [candidate({ id: 'swap-a', title: 'Library story time' })],
      weather: WET,
      composeMessage,
    });
    await expectTriedEverySlot(h, composeMessage);
    expect(composeMessage.mock.calls[0]?.[0].kind).toBe('weather_swap');
  });

  it('an empty Saturday is tried at every slot and still goes', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const composeMessage = failingWriter();
    const h = harness({
      saturdayPlans: { householdBusy: false, busyChildIds: new Set() },
      candidates: [
        candidate({
          id: 'sat-a',
          title: 'EarlyON Saturday',
          source: 'web',
          eventDate: SATURDAY,
          sourceUrl: 'https://tpl.example/sat-a',
        }),
      ],
      composeMessage,
    });
    await expectTriedEverySlot(h, composeMessage);
    expect(composeMessage.mock.calls[0]?.[0].kind).toBe('empty_saturday');
  });

  it('positive control: a written nudge sends those words and pages nobody', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const line = 'Richmond Hill Fall 2026 registration opens Tuesday, and Maya is in the band.';
    const h = harness({ windows: [win()], composeMessage: async () => ({ message: line }) });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(result).toMatchObject({ sent: 1, quiet: 0, unwritten: 0, resting: 0 });
    expect(h.transport.bodies()).toEqual([line]);
    expect(ledgerRows(h)).toHaveLength(1);
    expect(unwrittenRows(h)).toEqual([]);
    expect(h.pages).toEqual([]);
  });

  it('production wires the real writer, the real pager and the real count', () => {
    const wired = defaultNudgeModelOnlyDeps();
    expect(wired.composeMessage).toBe(writeNudgeModelOnly);
    expect(wired.page).toBe(pageOps);
    expect(wired.countAskFailures).toBe(countRecentAskFailures);
  });
});

describe('runNudgeCron — the weekday drop-in', () => {
  /** A Tuesday civic session, four days after FRIDAY_10AM. */
  const CIVIC: RadarCandidate[] = [
    {
      id: 'civic-1',
      title: 'EarlyON drop-in',
      venueName: 'Armour Heights',
      ageRange: null,
      priceLevel: 'free',
      indoorOutdoor: 'indoor',
      eventDate: '2026-08-04',
      seasons: null,
      childId: null,
      confidence: 0.9,
      source: 'web',
      sourceUrl: 'https://venue.example/dropin',
      access: null,
      whenLabel: null,
    },
  ];

  const AT_HOME: WeekdayCareContext = {
    stated: [
      {
        factId: 'fact-1',
        childId: 'child-1',
        care: 'home',
        provider: null,
        validFrom: FRIDAY_10AM,
      },
    ],
    askedBefore: true,
    weekendFindSent: true,
  };

  function armed() {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true');
  }

  /** No FSA, so the region-gated health checkpoints are off the table and these cases
   * decide between the weekend and the weekday rather than against a paperwork window. */
  const NO_REGION = [family({ areaCoarse: null })];

  it('a drop-in is tried at every slot and still goes', async () => {
    armed();
    const composeMessage = failingWriter();
    const h = harness({
      families: NO_REGION,
      children: SIX_MONTH_OLD,
      candidates: CIVIC,
      weekdayCare: AT_HOME,
      composeMessage,
    });
    await expectTriedEverySlot(h, composeMessage);
    expect(composeMessage.mock.calls[0]?.[0].kind).toBe('weekday_dropin');
  });
});

describe('runNudgeCron — the weekday-care ask', () => {
  const CIVIC: RadarCandidate[] = [
    {
      id: 'civic-1',
      title: 'EarlyON drop-in',
      venueName: 'Armour Heights',
      ageRange: null,
      priceLevel: 'free',
      indoorOutdoor: 'indoor',
      eventDate: '2026-08-04',
      seasons: null,
      childId: null,
      confidence: 0.9,
      source: 'web',
      sourceUrl: 'https://venue.example/dropin',
      access: null,
      whenLabel: null,
    },
  ];

  /** Asked nothing yet, sent a weekend find, said nothing back. */
  const UNASKED: WeekdayCareContext = {
    stated: [],
    askedBefore: false,
    weekendFindSent: true,
  };

  /** Two years old on FRIDAY_10AM. */
  const TODDLER: NudgeChildRow = {
    id: 'child-mia',
    name: 'Mia',
    dateOfBirth: '2024-06-01',
    dobPrecision: 'exact',
  };
  /** Fifteen. Never nameable over this channel (rule #1). */
  const TEEN: NudgeChildRow = {
    id: 'teen-ava',
    name: 'Ava',
    dateOfBirth: '2011-03-04',
    dobPrecision: 'exact',
  };

  const NO_REGION = [family({ areaCoarse: null })];

  function ask(children: NudgeChildRow[], composeMessage?: NudgeModelOnlyDeps['composeMessage']) {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true');
    return harness({
      families: NO_REGION,
      children,
      candidates: CIVIC,
      weekdayCare: UNASKED,
      composeMessage,
    });
  }

  function expectUnvoiced(h: Harness, result: { sent: number; quiet: number }) {
    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.writes.some((w) => w.table === schema.channelMessages)).toBe(false);
    const audit = h.writes.find((w) => w.table === schema.auditLog);
    expect(audit?.payload).toMatchObject({
      actionTaken: 'proactive_nudge_unwritten',
      after: { reason: 'unvoiced', kind: 'weekday_care' },
    });
    const text = JSON.stringify(audit?.payload);
    expect(text).not.toContain('Mia');
    expect(text).not.toContain('Ava');
    expect(text).not.toContain('Maya');
  }

  it('with no model, sends no template for the fallback ask', async () => {
    const h = ask([TODDLER]);
    expectUnvoiced(h, await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly));
  });

  it('with no model, stays quiet on a re-fire, because nothing was sent to dedupe', async () => {
    const h = ask([TODDLER]);
    await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    const again = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(again).toMatchObject({ sent: 0, deduped: 0 });
    expect(h.transport.bodies()).toEqual([]);
  });

  it('with no model, sends nothing when a toddler and a teenager share the house', async () => {
    const h = ask([TEEN, TODDLER]);
    expectUnvoiced(h, await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly));
  });

  it('with no model, sends nothing to a teen-only household, and does not name them', async () => {
    const h = ask([TEEN]);
    expectUnvoiced(h, await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly));
  });

  /** Seven on FRIDAY_10AM: the one school-age child the named ask is for. */
  const SCHOOLER: NudgeChildRow = {
    id: 'child-sam',
    name: 'Sam',
    dateOfBirth: '2019-03-04',
    dobPrecision: 'exact',
  };

  it.each([
    ['weekend_fallback', TODDLER],
    ['after_school_named', SCHOOLER],
    ['after_school_household', TEEN],
  ] as const)('%s has no date, so it rests after failing for any reason', async (prompt, child) => {
    keepTheDirectSendPath();
    const reasons: NudgeUnwrittenReason[] = ['no_client', 'model_failed', 'unusable'];
    expect(reasons).toHaveLength(MAX_UNDATED_ASK_FAILURES);
    const composeMessage = failingWriter();
    for (const reason of reasons) composeMessage.mockResolvedValueOnce({ unwritten: reason });
    const h = ask([child], composeMessage);
    for (const _reason of reasons) {
      const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
      expect(result).toMatchObject({ unwritten: 1, resting: 0 });
    }
    const asked = composeMessage.mock.calls[0]?.[0];
    expect(asked?.kind === 'weekday_care' && asked.ask.prompt).toBe(prompt);

    const rested = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(rested).toMatchObject({ sent: 0, quiet: 1, unwritten: 0, resting: 1 });
    expect(composeMessage).toHaveBeenCalledTimes(MAX_UNDATED_ASK_FAILURES);
    expect(h.transport.bodies()).toEqual([]);
  });

  describe('VIL-685 · the winter-break question while weekday care itself is off', () => {
    const BREAK_KNOWN: WeekdayCareContext = {
      stated: [],
      askedBefore: false,
      weekendFindSent: false,
      verifiedBreak: {
        eventKey: 'winter-break-2026-12-21',
        label: 'Winter Break',
        date: '2026-12-21',
        source: 'school_calendar',
      },
    };

    it('reaches the break rung on its own kill switch, and the after-school prompts stay dark', async () => {
      vi.stubEnv('F14_ENABLED', 'true');
      vi.stubEnv('SCHOOL_BREAK_ENABLED', 'true');
      const h = harness({
        families: NO_REGION,
        children: [TODDLER],
        candidates: CIVIC,
        weekdayCare: BREAK_KNOWN,
      });
      // No model in this harness: reaching the ask shows up as the unvoiced weekday ask.
      expectUnvoiced(h, await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly));
    });

    it('a verified break has its own date, so it is tried at every slot', async () => {
      vi.stubEnv('F14_ENABLED', 'true');
      vi.stubEnv('SCHOOL_BREAK_ENABLED', 'true');
      const composeMessage = failingWriter();
      const h = harness({
        families: NO_REGION,
        children: [TODDLER],
        candidates: CIVIC,
        weekdayCare: BREAK_KNOWN,
        composeMessage,
      });
      await expectTriedEverySlot(h, composeMessage);
      const asked = composeMessage.mock.calls[0]?.[0];
      expect(asked?.kind === 'weekday_care' && asked.ask.prompt).toBe('verified_break');
    });
  });
});

describe('runNudgeCron — empty Saturday', () => {
  it('does not send the fixed Saturday sentence when nothing can write one', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const h = harness({
      saturdayPlans: { householdBusy: false, busyChildIds: new Set() },
      candidates: [
        candidate({
          id: 'sat-1',
          title: 'EarlyON Saturday',
          source: 'web',
          eventDate: SATURDAY,
          sourceUrl: 'https://tpl.example/earlyon',
        }),
      ],
    });
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(result).toMatchObject({ sent: 0, quiet: 1 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.transport.bodies().join(' ')).not.toContain('looks open');
    const audit = h.writes.find((w) => w.table === schema.auditLog);
    expect(audit?.payload).toMatchObject({
      actionTaken: 'proactive_nudge_unwritten',
      after: { reason: 'saturday_unvoiced', kind: 'empty_saturday' },
    });
    expect(JSON.stringify(audit?.payload)).not.toContain('sat-1');
  });
});

const REFUSED_DRAFT = 'Want weekday stuff too? Tuesday at 9:15?';
const OPT_OUT_DRAFT = `Saturday looks good. ${NUDGE_OPT_OUT}`;

function answering(message: string): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ message }) }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })),
    },
  } as unknown as AgentClient;
}

function throwing(): AgentClient {
  const fail = vi.fn(async () => {
    throw new Error('model unavailable');
  });
  return { messages: { create: fail, stream: fail } } as unknown as AgentClient;
}

const CIVIC_SESSION = candidate({
  id: 'civic-1',
  title: 'EarlyON drop-in',
  venueName: 'Armour Heights',
  eventDate: '2026-08-04',
  source: 'web',
  sourceUrl: 'https://venue.example/dropin',
  confidence: 0.9,
});

const SATURDAY_URL = 'https://tpl.example/sat-a';

interface KindCase {
  kind: 'registration' | 'weather_swap' | 'weekday_dropin' | 'weekday_care' | 'empty_saturday';
  arm(): void;
  options: Parameters<typeof harness>[0];
  /** What main sends when the model fails: its fixed sentence, or nothing. */
  fixedText: string | null;
  goodDraft: string;
  /** The good draft as it reaches the parent. */
  sentText: string;
  skipReason: 'unvoiced' | 'saturday_unvoiced';
}

const KIND_CASES: KindCase[] = [
  {
    kind: 'registration',
    arm: () => {},
    options: { windows: [win()] },
    fixedText: 'Richmond Hill Fall 2026 registration opens Aug 4, 10:30 a.m. for Maya.',
    goodDraft: 'Richmond Hill Fall 2026 registration opens Aug 4, 10:30 a.m. for Maya.',
    sentText: 'Richmond Hill Fall 2026 registration opens Aug 4, 10:30 a.m. for Maya.',
    skipReason: 'unvoiced',
  },
  {
    kind: 'weather_swap',
    arm: () => {},
    options: { candidates: [candidate({ id: 'swap-a' })], weather: WET },
    fixedText:
      'The weekend forecast is wet, so Saturday: Library story time at Richmond Hill Library for Maya (free, indoor).',
    goodDraft: 'Library story time at Richmond Hill Library could suit Maya on Saturday.',
    sentText: 'Library story time at Richmond Hill Library could suit Maya on Saturday.',
    skipReason: 'unvoiced',
  },
  {
    kind: 'weekday_dropin',
    arm: () => vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true'),
    options: {
      families: [family({ areaCoarse: null })],
      children: SIX_MONTH_OLD,
      candidates: [CIVIC_SESSION],
      weekdayCare: {
        stated: [
          {
            factId: 'fact-1',
            childId: 'child-1',
            care: 'home',
            provider: null,
            validFrom: FRIDAY_10AM,
          },
        ],
        askedBefore: true,
        weekendFindSent: true,
      },
    },
    fixedText: 'Tuesday weekday drop-in: EarlyON drop-in at Armour Heights for Maya.',
    goodDraft: 'EarlyON drop-in at Armour Heights could suit Maya on Tuesday.',
    sentText: 'EarlyON drop-in at Armour Heights could suit Maya on Tuesday.',
    skipReason: 'unvoiced',
  },
  {
    kind: 'weekday_care',
    arm: () => vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true'),
    options: {
      families: [family({ areaCoarse: null })],
      children: [
        { id: 'child-mia', name: 'Mia', dateOfBirth: '2024-06-01', dobPrecision: 'exact' },
      ],
      candidates: [CIVIC_SESSION],
      weekdayCare: { stated: [], askedBefore: false, weekendFindSent: true },
    },
    fixedText: null,
    goodDraft:
      "Hey, I just noticed everything I've sent you so far has been for the weekend. Want me to look at weekday stuff too?",
    sentText:
      "Hey, I just noticed everything I've sent you so far has been for the weekend. Want me to look at weekday stuff too?",
    skipReason: 'unvoiced',
  },
  {
    kind: 'empty_saturday',
    arm: () => {},
    options: {
      saturdayPlans: { householdBusy: false, busyChildIds: new Set() },
      candidates: [
        candidate({
          id: 'sat-a',
          title: 'EarlyON Saturday',
          source: 'web',
          eventDate: SATURDAY,
          sourceUrl: SATURDAY_URL,
        }),
      ],
    },
    fixedText: null,
    goodDraft: 'EarlyON Saturday at Richmond Hill Library could suit Maya.',
    sentText: `EarlyON Saturday at Richmond Hill Library could suit Maya. ${SATURDAY_URL}`,
    skipReason: 'saturday_unvoiced',
  },
];

const FAILURES: Array<{
  name: string;
  reason: NudgeUnwrittenReason;
  client: () => AgentClient | null;
  skillFails?: boolean;
}> = [
  { name: 'no client', reason: 'no_client', client: () => null },
  {
    name: 'a missing skill',
    reason: 'skill_load',
    client: () => answering('never read'),
    skillFails: true,
  },
  { name: 'a model failure', reason: 'model_failed', client: throwing },
  { name: 'a refused draft', reason: 'unusable', client: () => answering(REFUSED_DRAFT) },
];

const CASES = KIND_CASES.flatMap((kindCase) =>
  FAILURES.map((failure) => ({ kindCase, failure, label: `${kindCase.kind}: ${failure.name}` })),
);

function armedHarness(kindCase: KindCase, client: AgentClient | null) {
  vi.stubEnv('F14_ENABLED', 'true');
  keepTheDirectSendPath();
  kindCase.arm();
  const h = harness({
    ...kindCase.options,
    composeMessage: writeNudgeModelOnly,
  });
  h.deps.client = client;
  return h;
}

function actions(h: Harness, verb: string) {
  return h.writes.filter(
    (write) => write.table === schema.auditLog && write.payload.actionTaken === verb,
  );
}

describe('the flag reads exact true only', () => {
  it.each([
    ['true', true],
    ['TRUE', false],
    ['true\n', false],
    ['1', false],
    ['', false],
  ])('%j -> %s', (value, on) => {
    vi.stubEnv('NUDGE_MODEL_ONLY_ENABLED', value);
    expect(nudgeModelOnlyEnabled()).toBe(on);
  });
});

describe('flag OFF: every kind behaves as main', () => {
  beforeEach(() => {
    vi.stubEnv('NUDGE_MODEL_ONLY_ENABLED', '');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(CASES)('$label', async ({ kindCase, failure }) => {
    skillLoad.fail = failure.skillFails === true;
    const h = armedHarness(kindCase, failure.client());

    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(h.pages).toEqual([]);
    expect(actions(h, 'proactive_nudge_unwritten')).toEqual([]);
    expect(result).toMatchObject({ unwritten: 0, resting: 0 });
    if (kindCase.fixedText !== null) {
      expect(result).toMatchObject({ sent: 1, failed: 0 });
      expect(h.transport.bodies()).toEqual([kindCase.fixedText]);
      return;
    }
    expect(h.transport.bodies()).toEqual([]);
    // main does not catch a weekday-ask skill failure: the family counts as failed.
    if (kindCase.kind === 'weekday_care' && failure.reason === 'skill_load') {
      expect(result).toMatchObject({ sent: 0, failed: 1 });
      expect(actions(h, 'proactive_nudge_skipped')).toEqual([]);
      return;
    }
    expect(result).toMatchObject({ sent: 0, quiet: 1, failed: 0 });
    const skipped = actions(h, 'proactive_nudge_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload.after).toEqual({
      reason: kindCase.skipReason,
      kind: kindCase.kind,
    });
  });

  it.each(KIND_CASES)('$kind: positive control, a good draft is sent unchanged', async (c) => {
    const h = armedHarness(c, answering(c.goodDraft));
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(h.transport.bodies()).toEqual([c.sentText]);
    expect(h.pages).toEqual([]);
  });

  it('a draft writing the opt-out line gets the fixed sentence, as on main', async () => {
    const registration = KIND_CASES[0] as KindCase;
    const h = armedHarness(registration, answering(OPT_OUT_DRAFT));
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result).toMatchObject({ sent: 1 });
    expect(h.transport.bodies()).toEqual([registration.fixedText]);
    expect(h.pages).toEqual([]);
  });
});

describe('flag ON: nothing is sent, one page, a named outcome, a retry', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each(CASES)('$label', async ({ kindCase, failure }) => {
    skillLoad.fail = failure.skillFails === true;
    const h = armedHarness(kindCase, failure.client());

    const first = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);

    expect(first).toMatchObject({ sent: 0, quiet: 1, unwritten: 1, resting: 0, failed: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.pages).toEqual([
      { site: 'nudge_unwritten', facts: { kind: kindCase.kind, reason: failure.reason } },
    ]);
    const rows = actions(h, 'proactive_nudge_unwritten');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.after).toMatchObject({
      reason: kindCase.skipReason,
      kind: kindCase.kind,
      unwritten: failure.reason,
    });

    skillLoad.fail = false;
    h.deps.client = answering(kindCase.goodDraft);
    const next = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(next).toMatchObject({ sent: 1, unwritten: 0, failed: 0 });
    expect(h.transport.bodies()).toEqual([kindCase.sentText]);
  });

  it.each(KIND_CASES)('$kind: positive control, a good draft is sent unchanged', async (c) => {
    const h = armedHarness(c, answering(c.goodDraft));
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result).toMatchObject({ sent: 1, unwritten: 0, failed: 0 });
    expect(h.transport.bodies()).toEqual([c.sentText]);
    expect(h.pages).toEqual([]);
  });

  it('a draft writing the opt-out line sends nothing and pages', async () => {
    const h = armedHarness(KIND_CASES[0] as KindCase, answering(OPT_OUT_DRAFT));
    const result = await runNudgeCron(db(), h.deps, FRIDAY_10AM, h.modelOnly);
    expect(result).toMatchObject({ sent: 0, unwritten: 1 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.pages).toEqual([
      { site: 'nudge_unwritten', facts: { kind: 'registration', reason: 'unusable' } },
    ]);
  });
});
