import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { type ActionType, ageInMonths, mintApprovedAction } from '@hale/types';
import { type ExecutorDeps, runExecutor } from '@hale/worker/executor';
import type { AgentClient } from '@hale/agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApproveQueue, approveDraftedAction } from '~/lib/actions/approve';
import { isUndoable } from '~/lib/actions/undo-window';
import {
  type CivicSessionForFamily,
  CIVIC_RUN_TYPE,
  CIVIC_SOURCE,
  selectCivicSessions,
} from '~/lib/civic/project';
import { WATCH_OFFER } from '~/lib/channel/intake/copy';
import { deriveDateOfBirth } from '~/lib/channel/intake/derive';
import type { IntakeCollected } from '~/lib/channel/intake/extract';
import {
  type FakeDb,
  FakeExtractor,
  FakeIntentReader,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { createIntakeAckComposer } from '~/lib/channel/intake/intake-voice';
import type { IntentReading } from '~/lib/channel/intake/intent';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { readCandidates, readWindows, createRadarComposer } from '~/lib/channel/intake/radar';
import { MAX_PAYLOAD_SEGMENTS } from '~/lib/channel/intake/radar-voice';
import { FakeTransport } from '~/lib/channel/intake/transport';
import {
  type NudgeFamily,
  type NudgeRunDeps,
  type NudgeRunResult,
  runNudgeCron,
} from '~/lib/channel/nudge/run';
import { NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { type OutboundGatePorts, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { roleAllows } from '~/lib/channel/role-scope';
import { approvalHandler } from '~/lib/channel/router/handlers';
import type { ApprovalSpine, PendingAction } from '~/lib/channel/router/approval';
import { approvedReceipt } from '~/lib/channel/router/copy';
import { smsSegments } from '~/lib/channel/sms-segments';
import { draftInlineAction } from '~/lib/coach/inline-action';
import { findBannedPhrases } from '~/lib/health/framing';
import { checkpointToldKeyPrefix } from '~/lib/health/told';
import { matchHealthCheckpoints } from '~/lib/health/match';
import { fulfillCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { matchRegistrationWindows } from '~/lib/registration/match-registration-windows';
import { buildShortlist } from '~/lib/registration/sequence/shortlist';
import { renderShortlistRationale, windowPhrase } from '~/lib/registration/sequence/copy';
import {
  type LiveSequence,
  type SequenceFamily,
  type SequenceRunDeps,
  type SequenceRunResult,
  legDedupeKey,
} from '~/lib/registration/sequence/run';
import { runRegistrationSequenceCron } from '~/lib/registration/sequence/run';
import { fakeWeather } from '~/lib/weather/open-meteo';

/**
 * VIL-260 — THE TODDLER JOURNEY, end to end, as ONE family.
 *
 * WHY THIS FILE EXISTS. The VIL-260 audit found 24 defects that every existing unit
 * test passed: a child stored six months too old, three transports that composed a
 * message and then dropped it, an approval spine whose approve step always failed at
 * execution. None of them were module bugs. Each module was correct in isolation and
 * the COMPOSITION was broken — which is exactly the class a per-module suite cannot
 * see, because every one of those suites stubbed the neighbour that was lying.
 *
 * So this test drives ONE seeded family — a 2-year-old and a 4-year-old in Markham
 * (L3R) — through the whole loop, and every assertion below is tied to a defect this
 * audit found. It runs on every PR: no network, no model, no database.
 *
 * WHAT IS REAL AND WHAT IS SUPPLIED. Everything that DECIDES is the real module:
 * `handleInboundSms`, `deriveDateOfBirth`, `createRadarComposer`, `selectCivicSessions`,
 * `assertProactiveSendAllowed` (via `buildOutboundGatePorts`), `decideNudge` (via
 * `runNudgeCron`), `matchHealthCheckpoints`, `matchRegistrationWindows`,
 * `buildShortlist`, `draftInlineAction`, `runExecutor`, `matchFastPath` +
 * `resolveApproval` (via `approvalHandler`), `approveDraftedAction`, `isUndoable`,
 * `roleAllows`.
 *
 * What is SUPPLIED is the row SCOPING. The repo's fake database
 * (lib/channel/intake/fakes.ts) deliberately does not evaluate WHERE clauses, and the
 * production loaders for the two sweeps are two-way INNER JOINs it cannot express. So
 * each loader below states the predicate its SQL applies and reads it off the same
 * store the journey wrote — the seam contract, not the decision. Every one of those is
 * marked `SEAM:` and names the module that owns the real query.
 *
 * NO MODEL DECIDES ANYTHING HERE. The radar runs on `client: null`, which is the real
 * production fallback (a deterministic render, see radar-voice.ts); the health nudge is
 * a static template by design; and the reviewer's SDK transport is scripted the way
 * inline-action.test.ts scripts it — loop mechanics, not an LLM-quality mock, and the
 * reviewer's real coverage gate still runs against the real tool results (rule #8).
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const GRANDPARENT_PHONE = '+16475550199';
const TZ = 'America/Toronto';
const AREA = 'L3R'; // Markham — the one municipality this FSA resolves to.

/** Friday 10:00 Toronto. The parent texts in. */
const INTAKE_AT = new Date('2026-07-31T14:00:00.000Z');
/** Sunday 10:00 Toronto, 48h later — the nudge slot (NUDGE_SEND_HOUR_LOCAL). */
const NUDGE_AT = new Date('2026-08-02T14:00:00.000Z');
/** Tuesday 10:00 Toronto — the shortlist slot AND T-7d on the window below. */
const SEQUENCE_AT = new Date('2026-08-18T14:00:00.000Z');
/** A later nudge slot, past the weekly cap window, after the parent has opted out. */
const WITHDRAWN_AT = new Date('2026-08-16T14:00:00.000Z');
/** The evening before the open, 19:00 Toronto — the battle-plan slot. */
const BATTLE_PLAN_AT = new Date('2026-08-24T23:00:00.000Z');
/** Tuesday 06:30 Toronto — when Markham's doors open. */
const WINDOW_OPEN = new Date('2026-08-25T10:30:00.000Z');

/** L3R's coarse centroid. Rule #1: an FSA's middle, never a home. */
const L3R_CENTRE = { lat: 43.8828, lng: -79.2663 };

const MARKHAM_SOURCE = 'https://www.markham.ca/en/recreation/registration.aspx';

const TODDLER_WINDOW_ID = '55555555-5555-4555-8555-555555555551';
const TEEN_WINDOW_ID = '55555555-5555-4555-8555-555555555552';

/**
 * A prod-shaped `registration_windows` row. All sixteen columns, including the ones a
 * seeded fixture is tempted to drop — `verifiedAt` and `sourceUrl` are NOT NULL in the
 * real table and the shortlist renders both.
 */
function registrationWindowRow(overrides: Partial<RegistrationWindow>): RegistrationWindow {
  return {
    id: TODDLER_WINDOW_ID,
    municipality: 'markham' as Municipality,
    programDomain: 'rec_program' as ProgramDomain,
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: WINDOW_OPEN,
    residentPriorityDays: null,
    waitlistResponseHours: 48,
    ageMinMonths: 12,
    ageMaxMonths: 60,
    sourceUrl: MARKHAM_SOURCE,
    verifiedAt: new Date('2026-07-30T00:00:00.000Z'),
    notes: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    ...overrides,
  } as RegistrationWindow;
}

/**
 * The toddler-matchable band (12–60 months) and, on the SAME page at the SAME instant,
 * a teen certification cycle. This is the Burlington co-opening shape: one registration
 * morning printed as several rows, where the sort's alphabetical tie-break used to
 * decide which one a household was told about.
 */
const TODDLER_WINDOW = registrationWindowRow({});
const TEEN_WINDOW = registrationWindowRow({
  id: TEEN_WINDOW_ID,
  programDomain: 'swim' as ProgramDomain,
  cycleLabel: 'Fall 2026 Aquatic Leadership',
  ageMinMonths: 144,
  ageMaxMonths: 215,
});

/**
 * A prod-shaped civic session: a weekly library drop-in with a real BiblioCommons-ish
 * audience band ("1 to 5 years" → 12–60 months) and venue coordinates. Weekly, so the
 * projection dates it to its next occurrence rather than leaving it evergreen.
 */
const CIVIC_SESSIONS: CivicSessionForFamily[] = [
  {
    id: 'civic-1',
    title: 'Family Storytime',
    summary: null,
    recurrence: 'weekly',
    startsAt: null,
    dayOfWeek: 6, // Saturday
    startMinute: 10 * 60 + 30,
    endMinute: 11 * 60,
    ageMinMonths: 12,
    ageMaxMonths: 60,
    registrationRequired: false,
    isCancelled: false,
    confidence: 0.9,
    sourceUrl: 'https://markham.bibliocommons.com/events/storytime',
    venueName: 'Markham Village Library',
    venueAddress: '6031 Highway 7',
    venueCity: 'Markham',
    venueUrl: 'https://www.markhampubliclibrary.ca/branches/mv',
    venueKind: 'library_branch',
    lat: 43.8845,
    lng: -79.2601,
  },
  {
    // A teen coding club at the same branch. It must never reach this household —
    // the band excludes both children, and that is the projection's own filter.
    id: 'civic-2',
    title: 'Teen Coding Club',
    summary: null,
    recurrence: 'weekly',
    startsAt: null,
    dayOfWeek: 6,
    startMinute: 14 * 60,
    endMinute: 15 * 60,
    ageMinMonths: 156,
    ageMaxMonths: 215,
    registrationRequired: false,
    isCancelled: false,
    confidence: 0.9,
    sourceUrl: 'https://markham.bibliocommons.com/events/teen-code',
    venueName: 'Markham Village Library',
    venueAddress: '6031 Highway 7',
    venueCity: 'Markham',
    venueUrl: 'https://www.markhampubliclibrary.ca/branches/mv',
    venueKind: 'library_branch',
    lat: 43.8845,
    lng: -79.2601,
  },
];

// ── the fakes this journey reuses, unchanged from their own suites ────────────

function assent(reply: string): IntentReading {
  return { intent: 'assent', verbatim: reply, interpretation: 'plain yes' };
}

/**
 * A view over the fake store that applies ONE predicate the fake db does not.
 *
 * The fake returns a whole table for any select (fakes.ts), which is fine for a module
 * whose own code re-filters — and wrong for one whose answer IS the query. Rather than
 * restate such a reader's logic in the test, this hands the reader the rows it would
 * actually have seen and lets its real code run over them.
 */
function scopedSelect(
  base: Database,
  scopes: ReadonlyArray<{ table: unknown; rows(): Record<string, unknown>[] }>,
): Database {
  const thenable = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['where', 'orderBy', 'from', 'innerJoin', 'leftJoin']) {
      chain[method] = () => chain;
    }
    chain.limit = () => Promise.resolve(rows);
    // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return chain;
  };
  return {
    ...(base as unknown as Record<string, unknown>),
    select: (projection: unknown) => ({
      from: (table: unknown) => {
        const scope = scopes.find((s) => s.table === table);
        if (scope) return thenable(scope.rows());
        return (base as unknown as { select(p: unknown): { from(t: unknown): unknown } })
          .select(projection)
          .from(table);
      },
    }),
  } as unknown as Database;
}

/**
 * The reviewer's SDK transport, scripted exactly as inline-action.test.ts scripts it:
 * the required `check_action_idempotency` call, then a verdict. Rule #8 holds — the
 * reviewer's coverage gate runs for real against the real tool result, and what is
 * faked is the loop's transport rather than the reviewer's judgement.
 */
function approvingReviewer(): AgentClient {
  const turns = [
    {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'check_action_idempotency',
          input: { actionHash: 'journey' },
        },
      ],
    },
    {
      content: [
        {
          type: 'tool_use',
          id: 'v1',
          name: 'submit_verdict',
          input: { verdict: 'approve', rationale: 'no recent duplicate' },
        },
      ],
    },
  ];
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    const turn = turns[call] ?? { content: [{ type: 'text', text: 'done' }] };
    call += 1;
    return {
      content: turn.content,
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null },
    };
  });
  return { messages: { create } } as unknown as AgentClient;
}

/** The executor's I/O, stubbed — the contract under test is the PAYLOAD the minter
 * hands the executor's dispatch, not the write it performs (inline-action.test.ts). */
function stubExecutorDeps(): ExecutorDeps {
  return {
    claimOutboundSend: vi.fn(async () => true),
    confirmOutboundSend: vi.fn(async () => {}),
    recordSkippedDuplicate: vi.fn(async () => {}),
    sendEmail: vi.fn(async () => ({ messageId: 'stub' })),
    addToRoutine: vi.fn(async () => 'written' as const),
    addToDigest: vi.fn(async () => 'written' as const),
    addToCalendar: vi.fn(async () => ({ outcome: 'written' as const, familyEventId: 'fe-1' })),
    moveCalendarEvent: vi.fn(async () => ({ outcome: 'written' as const, familyEventId: 'fe-1' })),
    cancelCalendarEvent: vi.fn(async () => ({
      outcome: 'written' as const,
      familyEventId: 'fe-1',
    })),
    // The invite leg is exercised end-to-end in lib/loop/calendar-invite.test.ts; here
    // it stands in as an unbound sender, whose report the execution detail still names.
    sendCalendarInvites: { send: vi.fn(async () => ({ status: 'not_configured' as const })) },
    calendar: {
      createEvent: vi.fn(async () => ({ providerEventId: 'stub' })),
      updateEvent: vi.fn(async () => ({ providerEventId: 'stub' })),
    },
  };
}

// ── the journey ──────────────────────────────────────────────────────────────

interface Journey {
  fake: FakeDb;
  transport: FakeTransport;
  familyId: string;
  parentUserId: string;
  externalAuthId: string;
  /** The one follow-up turn, before any age was given. */
  followUp: { status: string };
  provisionedStatus: string;
  radarBody: string;
  watch: { status: string; granted: boolean };
  nudge: NudgeRunResult;
  /** The same sweep, one week on, after the parent withdrew the watch consent. */
  afterWithdrawal: NudgeRunResult;
  /** Exactly what the nudge sweep handed the transport — sliced out of the recorder,
   * because every proactive class ships in the same CASL shell. */
  nudgeSends: Array<{ to: string; body: string }>;
  /** The four gate ports consulted for the nudge, in call order. */
  gateCalls: string[];
  propose: SequenceRunResult;
  battlePlan: SequenceRunResult;
  /** The action row the shortlist minted, as persisted. */
  draftedAction: Record<string, unknown>;
  approval: { claimed: boolean; outcome?: string; reply?: string | null };
  approvedPayload: Record<string, unknown> | null;
  /** The real executor's verdict on the minted payload. A rejection is captured rather
   * than thrown so it lands on the keystone assertion, with the executor's own
   * message, instead of taking every other stage down with it. */
  executed: { ok: boolean; error: string | null };
  caregiver: { accepted: string; scoped: string; reply: string };
}

let journey: Journey;

/** Every insert payload recorded for one table, in write order. */
function inserts(fake: FakeDb, table: unknown): Record<string, unknown>[] {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

/** The children AS STORED, read back the way every downstream consumer does: the age
 * comes out of the date, never out of what the parent said. */
function storedChildren(fake: FakeDb, now: Date) {
  return fake.rows(schema.children).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    dateOfBirth: row.dateOfBirth as string,
    dobPrecision: (row.dobPrecision === 'derived' ? 'derived' : 'exact') as 'derived' | 'exact',
    ageMonths: ageInMonths(row.dateOfBirth as string, now),
  }));
}

async function runToddlerJourney(): Promise<Journey> {
  const fake = makeFakeDb();
  const transport = new FakeTransport();

  // The municipal dataset this family's FSA resolves to, as the M1 sweep left it.
  await fake.db.insert(schema.registrationWindows).values(TODDLER_WINDOW as never);
  await fake.db.insert(schema.registrationWindows).values(TEEN_WINDOW as never);

  // ── STAGE 1-3 · intake, radar, consent ────────────────────────────────────
  const extractions: IntakeCollected[] = [
    // Turn one names both children and gives an age for only one of them.
    {
      children: [
        { name: 'Max', ageMonths: 48, agePrecision: 'years' },
        { name: 'Mia', ageMonths: null, agePrecision: null },
      ],
      postalCode: AREA,
    },
    // Turn two answers the follow-up. "18 months" is a POINT the parent already
    // narrowed; "4" is a bare year count and therefore a 12-month band.
    {
      children: [
        { name: 'Max', ageMonths: 48, agePrecision: 'years' },
        { name: 'Mia', ageMonths: 18, agePrecision: 'months' },
      ],
      postalCode: AREA,
    },
  ];

  const intakeDeps: IntakeDeps = {
    transport,
    extractor: new FakeExtractor(extractions),
    intentReader: new FakeIntentReader([assent('yes please')]),
    // The REAL radar composer, on the REAL production fallback path (`client: null`
    // renders deterministically — see radar-voice.ts), reading the same store intake
    // just wrote into.
    radar: createRadarComposer({
      database: fake.db,
      weather: fakeWeather([]),
      client: null,
      now: () => INTAKE_AT,
      timeZone: TZ,
    }),
    // SEAM: `projectCivicCandidates` is the production default here, and its read is a
    // civic_sessions INNER JOIN civic_venues the fake db cannot express. So the join is
    // supplied (the fixtures above ARE the joined rows) and the REAL selection —
    // age-band fit, proximity, next-occurrence dating — runs over them.
    seedCivic: async (_db, familyId, _areaCoarse, center, now) => {
      const ages = storedChildren(fake, now).map((child) => child.ageMonths);
      const picked = selectCivicSessions(CIVIC_SESSIONS, ages, center, now, TZ);
      for (const candidate of picked) {
        await fake.db.insert(schema.villageCandidates).values({
          familyId,
          title: candidate.title,
          kind: candidate.kind,
          summary: candidate.summary,
          source: CIVIC_SOURCE,
          runType: CIVIC_RUN_TYPE,
          confidence: candidate.confidence,
          priceLevel: 'free',
          indoorOutdoor: 'indoor',
          ageRange: candidate.ageRange,
          childId: null,
          eventDate: candidate.eventDate,
          seasons: null,
          venueName: candidate.venueName,
        } as never);
      }
      return picked.length;
    },
    resolveCenter: async () => L3R_CENTRE,
    discoveryTrigger: () => {},
    // Same discipline as the radar above: the REAL composer on the REAL production
    // fallback path (`null` client renders the deterministic follow-up and names the
    // reason), so the journey reads the words a family actually gets when voice is off.
    ackComposer: createIntakeAckComposer(null),
    limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
    now: INTAKE_AT,
  };

  const text = (body: string) => handleInboundSms(fake.db, transport.inbound(PARENT_PHONE, body), intakeDeps);

  await text('hi');
  const followUp = await text('Max and Mia, we are at L3R');
  const provisioned = await text('Max is 4, Mia is 18 months');
  const familyId = 'familyId' in provisioned ? (provisioned.familyId as string) : '';
  const radarBody = transport.bodies().at(-1) as string;
  const watched = await text('yes please');

  const parentUser = fake.rows(schema.users)[0] as { id: string; externalAuthId: string };

  // ── STAGE 4-5 · the 48h nudge, and what it carries ────────────────────────
  const gateCalls: string[] = [];
  const gatePorts = (database: Database): OutboundGatePorts => {
    const real = buildOutboundGatePorts(
      scopedSelect(database, [
        {
          // SEAM: the watch-consent read is latest-row-wins over THIS parent's
          // proactive_watch rows (outbound-gate.ts readWatchConsent). Unscoped, the
          // fake returns every consent row in the table starting with the CASL channel
          // consent — which passes the check without ever reading the watch answer.
          // Newest-first is what `ORDER BY granted_at DESC` gives; the fake applies no
          // column defaults, so insertion order is the only clock these rows have.
          table: schema.consentRecords,
          rows: () =>
            fake
              .rows(schema.consentRecords)
              .filter(
                (row) =>
                  row.userId === parentUser.id && row.consentType === 'proactive_watch',
              )
              .slice()
              .reverse(),
        },
        {
          // SEAM: the frequency cap counts this FAMILY's delivered proactive sends of
          // this class. Unscoped, the fake would count every intake message too and
          // hold the very first nudge.
          table: schema.channelMessages,
          rows: () =>
            fake
              .rows(schema.channelMessages)
              .filter(
                (row) =>
                  row.familyId === familyId &&
                  row.category === 'nudge' &&
                  row.direction === 'out' &&
                  ['sent', 'delivered'].includes(String(row.status)),
              ),
        },
      ]),
    );
    return {
      channelEnrolled: async (id) => {
        gateCalls.push('enrolled');
        return real.channelEnrolled(id);
      },
      watchConsentGranted: async (id) => {
        gateCalls.push('watch_consent');
        return real.watchConsentGranted(id);
      },
      countProactiveSends: async (fid, kind, since) => {
        gateCalls.push('frequency_cap');
        return real.countProactiveSends(fid, kind, since);
      },
      parentTimeZone: async (id) => {
        gateCalls.push('quiet_hours');
        return real.parentTimeZone(id);
      },
    };
  };

  /** SEAM: prod selects nudge families with families ⋈ family_members ⋈ users
   * (run.ts selectNudgeFamilies) — two INNER JOINs the fake cannot express. The
   * predicate it applies is restated here over the rows this journey wrote. */
  const nudgeFamilies = (): NudgeFamily[] => {
    const family = fake.rows(schema.families)[0] as Record<string, unknown>;
    if (family?.onboardingStage !== 'sms_active') return [];
    return [
      {
        familyId,
        parentUserId: parentUser.id,
        areaCoarse: family.areaCoarse as string,
        timeZone: TZ,
        provisionedAt: INTAKE_AT,
      },
    ];
  };

  const ledgerHas = (dedupeKey: string) =>
    fake
      .rows(schema.channelMessages)
      .some(
        (row) =>
          row.dedupeKey === dedupeKey && ['queued', 'sent', 'delivered'].includes(String(row.status)),
      );

  const nudgeDeps: NudgeRunDeps = {
    selectFamilies: async () => nudgeFamilies(),
    // SEAM: one family in the store, so the fake's unfiltered read IS this family's.
    loadChildren: async () =>
      storedChildren(fake, NUDGE_AT).map((child) => ({
        id: child.id,
        name: child.name,
        dateOfBirth: child.dateOfBirth,
        dobPrecision: child.dobPrecision,
      })),
    loadCandidates: (database, id) => readCandidates(database, id),
    loadWindows: (database, area) => readWindows(database, area),
    // SEAM: the real reader unions "already told" (a LIKE over the ledger's
    // told-markers, whatever surface wrote them — health/told.ts) with "said done"
    // (health/reply.ts). The LIKE is what is restated.
    loadSuppressedCheckpoints: async () => {
      const prefix = checkpointToldKeyPrefix(familyId);
      return new Set(
        fake
          .rows(schema.channelMessages)
          .map((row) => String(row.dedupeKey ?? ''))
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    },
    loadClaimedWindowIds: async () =>
      new Set(fake.rows(schema.registrationSequences).map((row) => row.windowId as string)),
    weather: fakeWeather([]),
    buildGate: gatePorts,
    // SEAM: the ledger's dedupe predicate (channel/ledger.ts dedupeActive).
    dedupeActive: async (_db, key) => ledgerHas(key),
    resolveSendablePhone: (database, id) => resolveSendablePhone(database, id),
    recordSend: async (database, write) => {
      const [row] = (await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' } as never)
        .returning({ id: schema.channelMessages.id })) as Array<{ id: string }>;
      if (!row) throw new Error('journey: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    transport,
    client: null,
    // MEM-10 · the REAL writer over the same store: a nudge that lands pays off the
    // intake radar's forward promise, and the journey is where that has to be true.
    fulfillCommitment,
  };

  vi.stubEnv('F14_ENABLED', 'true');
  const beforeNudge = transport.sent.length;
  const nudge = await runNudgeCron(fake.db, nudgeDeps, NUDGE_AT);
  const nudgeSends = transport.sent.slice(beforeNudge).map((sent) => ({ ...sent }));

  // ── STAGE 6 · the registration sequence ───────────────────────────────────
  const claimed = new Set<string>();
  const sequenceDeps: SequenceRunDeps = {
    /** SEAM: prod's selector is the same two INNER JOINs as the nudge's. */
    selectFamilies: async (): Promise<SequenceFamily[]> => {
      const family = fake.rows(schema.families)[0] as Record<string, unknown>;
      if (family?.onboardingStage !== 'sms_active') return [];
      return [
        {
          familyId,
          parentUserId: parentUser.id,
          areaCoarse: family.areaCoarse as string,
          timeZone: TZ,
        },
      ];
    },
    loadChildren: async () =>
      storedChildren(fake, SEQUENCE_AT).map((child) => ({
        id: child.id,
        name: child.name,
        dateOfBirth: child.dateOfBirth,
      })),
    loadWindows: (database, area) => readWindows(database, area),
    loadClaimedWindowIds: async () => new Set(claimed),
    // SEAM: prod's claim is an INSERT ... ON CONFLICT on the unique
    // (family_id, window_id) index — the atomic step two overlapping ticks race on.
    claimWindow: async (database, input) => {
      if (claimed.has(input.windowId)) return null;
      claimed.add(input.windowId);
      const [row] = (await database
        .insert(schema.registrationSequences)
        .values(input as never)
        .returning({ id: schema.registrationSequences.id })) as Array<{ id: string }>;
      return row?.id ?? null;
    },
    // The REAL approval spine the production sweep uses.
    draftShortlist: async (database, input) => {
      const { actionId } = await draftInlineAction(
        {
          familyId: input.familyId,
          actor: input.actorUserId,
          intentKind: input.intentKind,
          childId: input.childId,
          sourceAnswer: input.rationale,
          title: input.title,
          sourceUrl: input.sourceUrl,
          origin: 'registration_sweep',
          contentProvenance: 'hale_authored',
        },
        // SEAM: the reviewer's check_action_idempotency asks "has this family done
        // this before?". The fake answers with the whole actions table INCLUDING the
        // row under review — the self-match trap. Empty is what the real query
        // returns: no PRIOR action carries this draft's freshly minted hash.
        scopedSelect(database, [{ table: schema.actions, rows: () => [] }]),
        approvingReviewer(),
        SEQUENCE_AT,
      );
      return actionId;
    },
    attachAction: async (database, sequenceId, actionId) => {
      await database
        .update(schema.registrationSequences)
        .set({ actionId, updatedAt: SEQUENCE_AT })
        .where(eq(schema.registrationSequences.id, sequenceId));
    },
    releaseClaim: async () => {},
    /** SEAM: prod joins registration_sequences ⋈ windows ⋈ users ⋈ families and
     * LEFT JOINs actions to derive the opt-in from the approval spine's own columns. */
    loadLiveSequences: async (): Promise<LiveSequence[]> => {
      const rows = fake.rows(schema.registrationSequences);
      return rows.map((row) => {
        const action = fake
          .rows(schema.actions)
          .find((candidate) => candidate.id === row.actionId);
        const optIn =
          row.actionId == null
            ? ('missing' as const)
            : action?.revertedAt
              ? ('declined' as const)
              : action?.executedAt
                ? ('opted_in' as const)
                : ('pending' as const);
        return {
          sequenceId: row.id as string,
          familyId,
          parentUserId: parentUser.id,
          timeZone: TZ,
          areaCoarse: AREA,
          window: TODDLER_WINDOW,
          optIn,
          outcome: null,
          waitlistPosition: null,
          waitlistStartedAt: null,
        };
      });
    },
    buildGate: gatePorts,
    dedupeActive: async (_db, key) => ledgerHas(key),
    resolveSendablePhone: (database, id) => resolveSendablePhone(database, id),
    recordSend: async (database, write) => {
      const [row] = (await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' } as never)
        .returning({ id: schema.channelMessages.id })) as Array<{ id: string }>;
      if (!row) throw new Error('journey: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    transport,
    // MEM-10 · the REAL ledger over the same store: the heads-up leg's "I will send your
    // plan the evening before" is a promise, and the battle plan is what keeps it.
    recordCommitment,
    fulfillCommitment,
  };

  const propose = await runRegistrationSequenceCron(fake.db, sequenceDeps, SEQUENCE_AT);
  // Snapshotted: the store row is mutated below when the drain marks it executed, and
  // the assertion here is about the state the sweep LEFT it in (rule #4).
  const draftedAction = { ...(fake.rows(schema.actions)[0] as Record<string, unknown>) };

  // ── STAGE 7 · the parent approves, in their own words ─────────────────────
  const queue: ApproveQueue & { send: ReturnType<typeof vi.fn> } = {
    send: vi.fn(async () => 'job-1'),
  };
  const spine: ApprovalSpine = {
    listPending: async (): Promise<PendingAction[]> =>
      fake
        .rows(schema.actions)
        .filter((row) => row.userVisibleState === 'drafted_for_approval')
        .map((row) => ({ actionId: row.id as string, actionType: row.actionType as string })),
    latestUndoable: async () => null,
    approve: async (database, args) => {
      const result = await approveDraftedAction(database, queue, args);
      return result.status === 202;
    },
    decline: async () => false,
    undo: async () => false,
  };

  const approval = await approvalHandler(spine).handle(fake.db, {
    familyId,
    parentUserId: parentUser.id,
    body: 'sounds good',
    role: 'primary_parent',
    primaryParentName: null,
    conversationId: null,
    now: SEQUENCE_AT,
  } as never);
  const approvedPayload =
    (queue.send.mock.calls[0]?.[1] as Record<string, unknown> | undefined) ?? null;

  // The drain's half of the handshake, so the ladder can see the opt-in.
  await fake.db
    .update(schema.actions)
    .set({ userVisibleState: 'autonomous', executedAt: SEQUENCE_AT })
    .where(eq(schema.actions.id, draftedAction.id as string));

  const approved = mintApprovedAction(
    {
      id: draftedAction.id as string,
      eventId: draftedAction.eventId as string,
      familyId,
      actionType: draftedAction.actionType as ActionType,
      payload: draftedAction.payload as Record<string, unknown>,
      draftConfidence: 1,
      rationale: 'registration shortlist',
      recipientVisibility: 'internal_only',
      draftedAt: SEQUENCE_AT.toISOString(),
    },
    { kind: 'approve', rationale: 'ok', toolResults: [] },
    () => true,
  );
  const executed = await runExecutor({ familyId, approved }, stubExecutorDeps()).then(
    (result) => ({ ok: result.ok, error: null as string | null }),
    (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );

  const battlePlan = await runRegistrationSequenceCron(fake.db, sequenceDeps, BATTLE_PLAN_AT);

  // ── STAGE 8 · a grandparent joins, scoped ─────────────────────────────────
  await text('add Grandma 647-555-0199 as grandparent');
  await text('yes');
  const granText = (body: string) =>
    handleInboundSms(fake.db, transport.inbound(GRANDPARENT_PHONE, body), intakeDeps);
  const accepted = await granText('yes');
  const scoped = await granText('is Mia feeling better after her shots?');

  // ── coda · the parent withdraws ───────────────────────────────────────────
  // The CASL ledger is append-only, so a withdrawal is a NEW granted=false row rather
  // than an edit — which is exactly why a naive `granted = true` existence check reads
  // "yes" for a household that has already opted out.
  await fake.db.insert(schema.consentRecords).values({
    userId: parentUser.id,
    familyId,
    consentType: 'proactive_watch',
    granted: false,
    consentScope: 'proactive_watch',
    policyVersion: 'journey',
  } as never);
  const afterWithdrawal = await runNudgeCron(fake.db, nudgeDeps, WITHDRAWN_AT);

  return {
    fake,
    transport,
    familyId,
    parentUserId: parentUser.id,
    afterWithdrawal,
    externalAuthId: parentUser.externalAuthId,
    followUp,
    provisionedStatus: provisioned.status,
    radarBody,
    watch: {
      status: watched.status,
      granted: 'granted' in watched ? Boolean(watched.granted) : false,
    },
    nudge,
    nudgeSends,
    gateCalls,
    propose,
    battlePlan,
    draftedAction,
    approval,
    approvedPayload,
    executed,
    caregiver: {
      accepted: accepted.status,
      scoped: scoped.status,
      reply: transport.bodies().at(-1) as string,
    },
  };
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  journey = await runToddlerJourney();
});

afterAll(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

// ── stage 1 · intake ─────────────────────────────────────────────────────────

describe('1 · intake provisions the family the parent actually described', () => {
  it('refuses to provision anyone until every child has an age (WS1 P0)', () => {
    // The turn that named both children but aged only one wrote NOTHING. An invented
    // date is the one thing this path may never produce: every stage, checkpoint and
    // registration band downstream is computed out of it.
    expect(journey.followUp.status).toBe('follow_up_asked');
    expect(journey.provisionedStatus).toBe('provisioned');
    const children = journey.fake.rows(schema.children);
    expect(children).toHaveLength(2);
    expect(children.every((child) => typeof child.dateOfBirth === 'string')).toBe(true);
  });

  it('reads 18 months back as eighteen months, not twenty-four (WS1 P0)', () => {
    const [max, mia] = storedChildren(journey.fake, INTAKE_AT);
    // "18 months" is the parent's own narrowing — the estimate, not a band to centre.
    expect(mia?.name).toBe('Mia');
    expect(mia?.ageMonths).toBe(18);
    // "4" is a bare year count, so it IS a 12-month band and its midpoint is the read
    // with the smallest worst case. The two rules are different on purpose.
    expect(max?.name).toBe('Max');
    expect(max?.ageMonths).toBe(54);
    expect(mia?.dobPrecision).toBe('derived');
  });
});

// ── stage 2 · the first radar ────────────────────────────────────────────────

describe('2 · the first reply names something real', () => {
  it('is not structurally empty — it names a seeded civic session and the matched window', () => {
    expect(journey.radarBody.toLowerCase()).not.toContain('still learning');
    expect(journey.radarBody).toContain('Family Storytime');
    // Markham's real open instant, in the family's own zone.
    expect(journey.radarBody).toContain('Aug 25');
  });

  it('fits the segment budget the whole payload is measured against', () => {
    // The body already carries the watch offer, which is how radar-voice measures it.
    expect(journey.radarBody).toContain(WATCH_OFFER);
    expect(smsSegments(journey.radarBody)).toBeLessThanOrEqual(MAX_PAYLOAD_SEGMENTS);
  });

  it('invents no venue, no time and no programme it was not given', () => {
    // Every fact in the body traces to a seeded row. The two things in this family's
    // catchment that do NOT fit these children are the teen band and the teen club,
    // and neither may appear.
    expect(journey.radarBody).not.toContain('Teen Coding Club');
    expect(journey.radarBody).not.toContain('Aquatic Leadership');
    // The projection dated the drop-in to its next occurrence, so a Saturday-only
    // session can never be offered as a Sunday plan.
    const candidates = journey.fake.rows(schema.villageCandidates);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.eventDate).toBe('2026-08-01');
  });
});

// ── stage 3 · consent ────────────────────────────────────────────────────────

describe('3 · watch consent is recorded in the parent\'s own words', () => {
  it('records "yes please" verbatim, as a grant', () => {
    expect(journey.watch).toEqual({ status: 'watch_recorded', granted: true });
    const watch = inserts(journey.fake, schema.consentRecords).find(
      (row) => row.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(true);
    expect(watch?.evidence).toMatchObject({
      question: WATCH_OFFER,
      verbatimReply: 'yes please',
    });
  });

  it('writes the consent BEFORE the family becomes proactively contactable', () => {
    // Nothing unprompted may be sent until this row exists, and the ordering is what
    // makes that true under a crash: the sweep selects on sms_active only.
    const consentIndex = journey.fake.writes.findIndex(
      (w) =>
        w.op === 'insert' &&
        w.table === schema.consentRecords &&
        w.payload.consentType === 'proactive_watch',
    );
    const flipIndex = journey.fake.writes.findIndex(
      (w) =>
        w.op === 'update' &&
        w.table === schema.families &&
        w.payload.onboardingStage === 'sms_active',
    );
    expect(consentIndex).toBeGreaterThanOrEqual(0);
    expect(flipIndex).toBeGreaterThan(consentIndex);
  });
});

// ── stage 4 · the 48h nudge actually leaves the building ─────────────────────

describe('4 · the 48h nudge reaches a transport', () => {
  it('fires for this family and passes all four outbound-gate checks in order', () => {
    expect(journey.nudge).toMatchObject({ enabled: true, evaluated: 1, sent: 1, quiet: 0 });
    expect(journey.nudge.held).toEqual({
      not_enrolled: 0,
      no_watch_consent: 0,
      frequency_cap: 0,
      quiet_hours: 0,
    });
    // Every check ran, against the rows intake wrote — not a stub that said yes.
    expect(journey.gateCalls.slice(0, 4)).toEqual([
      'enrolled',
      'watch_consent',
      'frequency_cap',
      'quiet_hours',
    ]);
  });

  it('ACTUALLY sends — a composed payload that never reached the transport is the defect (WS2 P0)', () => {
    // `sent: 1` alone would still pass with a transport that swallowed the message;
    // this is the recorder on the other side of the seam.
    expect(journey.nudgeSends).toHaveLength(1);
    expect(journey.nudgeSends[0]?.to).toBe(PARENT_PHONE);
    expect(journey.nudgeSends[0]?.body.endsWith(NUDGE_OPT_OUT)).toBe(true);
    // And the ledger row that consumes the family's weekly budget was written only
    // because the message left — its provider id is the one the transport returned.
    const ledger = journey.fake
      .rows(schema.channelMessages)
      .filter((row) => row.category === 'nudge');
    expect(ledger).toHaveLength(1);
    expect(String(ledger[0]?.providerMessageId)).toMatch(/^fake-out-\d+$/);
  });
});

describe('4c · a withdrawn watch consent holds the next sweep', () => {
  it('reads the appended granted=false row as the answer that stands now', () => {
    // Proof the consent check is doing work rather than passing vacuously: the same
    // family, the same slot logic, the same live channel — and no send.
    expect(journey.afterWithdrawal).toMatchObject({ enabled: true, evaluated: 1, sent: 0 });
    expect(journey.afterWithdrawal.held.no_watch_consent).toBe(1);
    // First failure wins, so nothing past the consent check was even looked at.
    expect(journey.afterWithdrawal.held.frequency_cap).toBe(0);
  });
});

// ── stage 5 · health ─────────────────────────────────────────────────────────

describe('5 · the 18-month checkpoints are offered to Mia', () => {
  it('matches both Ontario 18-month rows off the STORED date (the case the DOB bug made impossible)', () => {
    const children = storedChildren(journey.fake, NUDGE_AT);
    const matches = matchHealthCheckpoints({
      children: children.map((child) => ({
        id: child.id,
        name: child.name,
        ageMonths: child.ageMonths,
        dobPrecision: child.dobPrecision,
        isTeen: false,
      })),
      areaCoarse: AREA,
      suppressedRefs: new Set<string>(),
      now: NUDGE_AT,
    });
    const ids = matches.map((match) => match.checkpoint.id);
    expect(ids).toContain('immunization_18_months');
    expect(ids).toContain('well_baby_18_months');
    // Both bands are [18, 23] and the matcher never widens the LATE edge, so a child
    // stored at 24 months could never be shown either one.
    expect(matches[0]?.kidNames).toContain('Mia');
  });

  it('is the errand the nudge actually carried, and its framing is neither clinical nor alarmist', () => {
    const body = journey.nudgeSends[0]?.body as string;
    expect(body).toContain('Mia');
    expect(body).toContain('18 months');
    // The lint runs over the ASSEMBLED message: no judgement, no diagnosis, no
    // deadline language, no teen wording for a toddler.
    expect(findBannedPhrases(body)).toEqual([]);
    const audit = journey.fake
      .rows(schema.auditLog)
      .find((row) => row.actionTaken === 'proactive_nudge_sent');
    expect((audit?.after as Record<string, unknown>)?.kind).toBe('health_checkpoint');
    expect((audit?.after as Record<string, unknown>)?.checkpointId).toBe(
      'immunization_18_months',
    );
  });
});

// ── stage 6 · the registration sequence ──────────────────────────────────────

describe('6 · the registration sequence claims the window and prepares the morning', () => {
  it('claims exactly one window and drafts one shortlist for approval', () => {
    expect(journey.propose).toMatchObject({ enabled: true, proposed: 1 });
    const sequences = journey.fake.rows(schema.registrationSequences);
    expect(sequences).toHaveLength(1);
    expect(sequences[0]?.windowId).toBe(TODDLER_WINDOW_ID);
    // Rule #4: drafted, never executed.
    expect(journey.draftedAction.userVisibleState).toBe('drafted_for_approval');
  });

  it('fires the heads-up leg first, and holds the battle plan until the parent has said yes', () => {
    // The heads-up carries the news M4 would have carried, so it fires at optIn
    // 'pending'. Everything after it presumes a yes.
    const legs = journey.fake
      .rows(schema.auditLog)
      .filter((row) => row.actionTaken === 'registration_sequence_leg_sent')
      .map((row) => (row.after as Record<string, unknown>).leg);
    expect(legs).toEqual(['heads_up', 'battle_plan']);
    expect(journey.propose.sent).toBe(1);
    expect(journey.battlePlan.sent).toBe(1);
    const keys = journey.fake
      .rows(schema.channelMessages)
      .filter((row) => row.category === 'registration_sequence')
      .map((row) => row.dedupeKey);
    expect(keys).toEqual([
      legDedupeKey(journey.familyId, TODDLER_WINDOW_ID, 'heads_up'),
      legDedupeKey(journey.familyId, TODDLER_WINDOW_ID, 'battle_plan'),
    ]);
  });

  it('mints a payload the REAL executor accepts (WS3 P0)', () => {
    // Every other test on this path stopped at "a draft row was written". Pre-fix the
    // minter wrote {intentKind, childId} only, so approving ANY draft threw
    // "payload missing required field (title)" at execution — every time.
    expect(journey.draftedAction.payload).toMatchObject({
      intentKind: 'registration_shortlist',
      title: expect.stringContaining('Markham'),
      source_url: MARKHAM_SOURCE,
    });
    expect(journey.executed.error).toBeNull();
    expect(journey.executed.ok).toBe(true);
  });

  it('never hands this household a teen band, even when the cycles co-open', () => {
    const ages = storedChildren(journey.fake, SEQUENCE_AT).map((child) => child.ageMonths);
    const matches = matchRegistrationWindows({
      windows: [TODDLER_WINDOW, TEEN_WINDOW],
      postal: AREA,
      childrenAgesMonths: ages,
      now: SEQUENCE_AT,
    });
    // The teen certification cycle opens at the same instant on the same page. It is
    // excluded by its published band, and the band is part of the co-opening key so it
    // cannot be merged into the toddler event either.
    expect(matches).toHaveLength(1);
    expect(matches[0]?.window.id).toBe(TODDLER_WINDOW_ID);
    expect(matches.flatMap((match) => [...match.cycleWindows]).map((w) => w.id)).toEqual([
      TODDLER_WINDOW_ID,
    ]);

    const shortlist = buildShortlist(
      matches[0] as never,
      storedChildren(journey.fake, SEQUENCE_AT),
      SEQUENCE_AT,
    );
    expect(windowPhrase(shortlist as never)).not.toContain('Aquatic Leadership');
    // Both children are squarely inside 12–60 months, so nothing is hedged.
    expect(shortlist?.fitNotes.map((note) => note.fit)).toEqual(['in_band', 'in_band']);
    expect(renderShortlistRationale(shortlist as never, TZ, SEQUENCE_AT)).toContain(
      'I never register for you',
    );
  });
});

// ── stage 7 · approval → receipt ─────────────────────────────────────────────

describe('7 · the parent approves in their own words and the receipt is theirs', () => {
  it('reads "sounds good" as consent and approves the one drafted action', () => {
    expect(journey.approval).toMatchObject({ claimed: true, outcome: 'approved' });
    expect(journey.approval.reply).toBe(approvedReceipt('add_to_digest_only'));
  });

  it('stamps the INTERNAL users.id as the approver, which is the id the family owns (WS3 P0)', () => {
    // The routes used to write the caller's EXTERNAL Auth.js id. Nothing in the family
    // owns that id — family_members.user_id holds the internal one — so the trail
    // resolver found no member and credited the parent's own consent to Hale, on the
    // History timeline AND in the PIPEDA export.
    const member = journey.fake.rows(schema.familyMembers)[0] as { userId: string };
    expect(journey.approvedPayload?.approved_by).toBe(journey.parentUserId);
    expect(journey.approvedPayload?.approved_by).toBe(member.userId);
    expect(journey.approvedPayload?.approved_by).not.toBe(journey.externalAuthId);
    expect(journey.externalAuthId).toMatch(/^sms:[0-9a-f]{64}$/);
  });

  it('leaves an immutable, family-scoped trail of every transition (rule #6)', () => {
    const trail = journey.fake.rows(schema.auditLog);
    const actions = trail.map((row) => row.actionTaken);
    expect(actions).toContain('proactive_watch_granted');
    expect(actions).toContain('proactive_nudge_sent');
    expect(actions).toContain('registration_shortlist_drafted');
    expect(actions).toContain('registration_sequence_leg_sent');
    expect(trail.every((row) => row.familyId === journey.familyId)).toBe(true);
  });

  it('offers undo exactly where a reversal exists, and only inside its window', () => {
    // The shortlist itself is deliberately NOT reversible: its action type has no
    // executor that could have registered for anyone (D8), so there is nothing to
    // take back. A calendar placement is the reversible one, for 24 hours.
    const executedAt = SEQUENCE_AT;
    expect(
      isUndoable(
        {
          actionType: journey.draftedAction.actionType as string,
          userVisibleState: 'autonomous',
          executedAt,
        },
        new Date(executedAt.getTime() + 60 * 60_000),
      ),
    ).toBe(false);
    expect(
      isUndoable(
        { actionType: 'calendar_add', userVisibleState: 'autonomous', executedAt },
        new Date(executedAt.getTime() + 60 * 60_000),
      ),
    ).toBe(true);
    expect(
      isUndoable(
        { actionType: 'calendar_add', userVisibleState: 'autonomous', executedAt },
        new Date(executedAt.getTime() + 25 * 60 * 60_000),
      ),
    ).toBe(false);
  });
});

// ── stage 8 · caregiver scope ────────────────────────────────────────────────

describe('8 · a grandparent on this family never receives health or teen content', () => {
  it('answers a health question with the one scoped line, and nothing about the child', () => {
    expect(journey.caregiver.accepted).toBe('caregiver_accepted');
    expect(journey.caregiver.scoped).toBe('caregiver_scoped_reply');
    expect(journey.caregiver.reply).toContain('I only share the schedule here');
    // Not a word of what was asked about, and no model was consulted to decide that.
    expect(journey.caregiver.reply).not.toContain('Mia');
    expect(journey.caregiver.reply).not.toContain('shots');
  });

  it('denies the health and teen content classes to the role, at the table', () => {
    expect(roleAllows('grandparent', 'health')).toBe(false);
    expect(roleAllows('grandparent', 'teen_content')).toBe(false);
    expect(roleAllows('grandparent', 'registration')).toBe(false);
    // What a caregiver IS for: where to be, when, and for what.
    expect(roleAllows('grandparent', 'schedule')).toBe(true);
    expect(roleAllows('grandparent', 'pickup_duty')).toBe(true);
    expect(roleAllows('grandparent', 'event_logistics')).toBe(true);
  });
});

/**
 * A pinned derivation, not a journey stage: the age-precision rule the whole journey
 * is computed from, stated against the spec rather than against what the code returns.
 *
 * On the journey's OWN clock, deliberately — the 31st is the date that used to roll a
 * shorter target month forward and read a child back a month young (VIL-263), so it is
 * the clock this property is worth asserting on rather than a safely-chosen one.
 */
describe('the age rule the whole journey is computed from', () => {
  it('round-trips a stated month count exactly, and centres only a bare year count', () => {
    for (const stated of [1, 6, 12, 18, 24, 30, 42, 60]) {
      expect(ageInMonths(deriveDateOfBirth(stated, 'months', INTAKE_AT), INTAKE_AT)).toBe(stated);
    }
    // A bare year count is a 12-month band, so the midpoint is the read with the
    // smallest worst case. This is the ONLY case that earns the correction.
    expect(ageInMonths(deriveDateOfBirth(24, 'years', INTAKE_AT), INTAKE_AT)).toBe(30);
    expect(ageInMonths(deriveDateOfBirth(48, 'years', INTAKE_AT), INTAKE_AT)).toBe(54);
  });
});
