import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { createIntakeAckComposer } from '~/lib/channel/intake/intake-voice';
import { createRadarComposer, readCandidates, readWindows } from '~/lib/channel/intake/radar';
import {
  FIRST_FIND_BEAT,
  FIRST_FIND_DUE_HOURS,
} from '~/lib/channel/intake/radar-voice';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type NudgeRunDeps, type NudgeRunResult, runNudgeCron } from '~/lib/channel/nudge/run';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { aggregateCommitmentDebt, fulfillCommitment, loadOpenCommitments } from '~/lib/commitments/ledger';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { fakeWeather } from '~/lib/weather/open-meteo';

/**
 * MEM-10 · A PROMISE HALE KEEPS — the open-loops ledger across the two surfaces that
 * actually make and settle one.
 *
 * The defect this file exists for: the radar tells a family Hale had nothing for that
 * "your first weekend find lands in a day or two", and until this ledger the ONLY thing
 * holding that sentence was the hope that the 48h sweep would happen to select them. It
 * lived in a transcript, which is exactly the content compaction is entitled to throw
 * away, and nothing anywhere could answer "which families is Hale late to?".
 *
 * So the two surfaces are driven here in sequence, over one store: the REAL intake
 * machine and the REAL radar composer (on `client: null`, the production deterministic
 * path — rule #8), then the REAL nudge sweep once discovery has finally found this
 * family something.
 *
 * SEAM discipline is the toddler journey's: the fake database does not evaluate WHERE
 * clauses, so each loader below restates the predicate its production SQL applies and
 * names the module that owns it. Where the LEDGER's own predicate is the thing a fake
 * cannot express, the assertion drops to the stored row and says so.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const PARENT_PHONE = '+14165550100';
const TZ = 'America/Toronto';
/** Halton Hills: outside civic-adapter coverage, no registration windows, nothing
 * discovered yet — the geo-empty cohort the forward beat exists for. */
const AREA = 'L7G';
/** Friday 10:00 Toronto — the parent texts in. */
const INTAKE_AT = new Date('2026-07-31T14:00:00.000Z');
/** Where "a day or two" runs out, per the promise's own clock. */
const DUE_AT = new Date(INTAKE_AT.getTime() + FIRST_FIND_DUE_HOURS * 3_600_000);
/** An hour past due, with nothing sent yet: Hale is late, and must read as late. */
const OVERDUE_AT = new Date(DUE_AT.getTime() + 3_600_000);
/** The NEXT Friday 10:00 Toronto — this family's slot, a week on. */
const NUDGE_AT = new Date('2026-08-07T14:00:00.000Z');

/**
 * Thirty months old, and the age is the point: it sits in the one gap in Ontario's
 * checkpoint table (24–47 months), so the radar's third rung is empty too. All three
 * rungs empty is the ONLY shape that earns the forward beat.
 */
const NORA = { name: 'Nora', ageMonths: 30, agePrecision: 'months' } as const;

/** Washed out, so the weekend swap the nudge finally sends has a real forecast behind
 * it (M4 refuses a swap with no weather fact). Saturday/Sunday after {@link NUDGE_AT}. */
const WET = [
  { date: '2026-08-08', precipitationChancePct: 95, highTempC: 18 },
  { date: '2026-08-09', precipitationChancePct: 95, highTempC: 18 },
];

// ── surface 1 · the intake radar ─────────────────────────────────────────────

interface Intake {
  fake: FakeDb;
  transport: FakeTransport;
  familyId: string;
  /** The message the radar actually sent, watch offer and all. */
  radarBody: string;
}

async function runIntakeRadar(): Promise<Intake> {
  const fake = makeFakeDb();
  const transport = new FakeTransport();

  const deps: IntakeDeps = {
    transport,
    extractor: new FakeExtractor([{ children: [NORA], postalCode: AREA }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes please', interpretation: 'a clear yes' },
    ]),
    // The REAL composer on the REAL production fallback path: `client: null` renders
    // deterministically, so the sentence asserted below is the sentence a family gets.
    radar: createRadarComposer({
      database: fake.db,
      weather: fakeWeather([]),
      client: null,
      now: () => INTAKE_AT,
      timeZone: TZ,
    }),
    // Nothing to seed and nowhere to place it: this family's whole point is that
    // geography has nothing for them yet.
    seedCivic: async () => 0,
    resolveCenter: async () => null,
    discoveryTrigger: () => {},
    ackComposer: createIntakeAckComposer(null),
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
    now: INTAKE_AT,
  };

  const text = (body: string) =>
    handleInboundSms(fake.db, transport.inbound(PARENT_PHONE, body), deps);

  await text('hi');
  const provisioned = await text('Nora is 30 months, we are at L7G');
  const familyId = 'familyId' in provisioned ? (provisioned.familyId as string) : '';
  const radarBody = transport.bodies().at(-1) as string;
  await text('yes please');

  return { fake, transport, familyId, radarBody };
}

// ── surface 2 · the sweep that pays it off ───────────────────────────────────

/** The gate is not what this file tests — the toddler journey drives its four real
 * ports against real rows. Here it says yes, so the ledger is the only thing under
 * test. */
const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  parentTimeZone: async () => TZ,
});

/** Discovery, landing late — the background half of seedFirstRadar, which is the whole
 * reason the beat is true rather than hopeful. One indoor free session, in the store. */
async function discoveryFinallyLands(fake: FakeDb, familyId: string): Promise<void> {
  await fake.db.insert(schema.villageCandidates).values({
    familyId,
    title: 'Library story time',
    venueName: 'Halton Hills Library',
    ageRange: null,
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    eventDate: null,
    seasons: null,
    childId: null,
    confidence: 0.8,
    runType: 'standing',
    supersededAt: null,
  } as never);
}

function nudgeDeps(fake: FakeDb, transport: FakeTransport, familyId: string): NudgeRunDeps {
  return {
    /** SEAM: prod selects families ⋈ family_members ⋈ users (run.ts
     * selectNudgeFamilies) — two INNER JOINs the fake cannot express. */
    selectFamilies: async () => {
      const family = fake.rows(schema.families)[0] as Record<string, unknown> | undefined;
      if (family?.onboardingStage !== 'sms_active') return [];
      return [
        {
          familyId,
          parentUserId: fake.rows(schema.users)[0]?.id as string,
          areaCoarse: family.areaCoarse as string,
          timeZone: TZ,
          provisionedAt: INTAKE_AT,
        },
      ];
    },
    // SEAM: one family in the store, so the fake's unfiltered read IS this family's.
    loadChildren: async () =>
      fake.rows(schema.children).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        dateOfBirth: row.dateOfBirth as string,
        dobPrecision: row.dobPrecision === 'derived' ? ('derived' as const) : ('exact' as const),
      })),
    loadCandidates: (database, id) => readCandidates(database, id),
    loadWindows: (database, area) => readWindows(database, area),
    loadSuppressedCheckpoints: async () => new Set<string>(),
    loadClaimedWindowIds: async () => new Set<string>(),
    weather: fakeWeather(WET),
    buildGate: openGate,
    // SEAM: the ledger's dedupe predicate (channel/ledger.ts dedupeActive).
    dedupeActive: async (_database, key) =>
      fake.rows(schema.channelMessages).some((row) => row.dedupeKey === key),
    resolveSendablePhone: async () => PARENT_PHONE,
    recordSend: async (database, write) => {
      const [row] = (await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' } as never)
        .returning({ id: schema.channelMessages.id })) as Array<{ id: string }>;
      if (!row) throw new Error('open-loop: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    transport,
    client: null,
    // The REAL ledger writer over the same store.
    fulfillCommitment,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

interface Journey {
  intake: Intake;
  /** The commitment row as it stood right after intake — snapshotted, because the
   * sweep below mutates it in place. */
  promised: Record<string, unknown>;
  /** The debt, read an hour after the promise fell due and before any nudge. */
  overdue: Awaited<ReturnType<typeof aggregateCommitmentDebt>>;
  open: Awaited<ReturnType<typeof loadOpenCommitments>>;
  sweep: NudgeRunResult;
  sweepBodies: string[];
}

let journey: Journey;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('F14_ENABLED', 'true');

  const intake = await runIntakeRadar();
  const promised = { ...(intake.fake.rows(schema.agentCommitments)[0] ?? {}) };
  const overdue = await aggregateCommitmentDebt(intake.fake.db, OVERDUE_AT);
  const open = await loadOpenCommitments(intake.fake.db, intake.familyId, OVERDUE_AT);

  await discoveryFinallyLands(intake.fake, intake.familyId);
  const before = intake.transport.sent.length;
  const sweep = await runNudgeCron(
    intake.fake.db,
    nudgeDeps(intake.fake, intake.transport, intake.familyId),
    NUDGE_AT,
  );

  journey = {
    intake,
    promised,
    overdue,
    open,
    sweep,
    sweepBodies: intake.transport.bodies().slice(before),
  };
});

afterAll(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('the radar makes a promise', () => {
  it('says the forward beat out loud, having nothing else to offer', () => {
    expect(journey.intake.radarBody).toContain(FIRST_FIND_BEAT);
  });

  it('records it as a row, against the message that carried it', () => {
    expect(journey.intake.fake.rows(schema.agentCommitments)).toHaveLength(1);
    expect(journey.promised).toMatchObject({
      familyId: journey.intake.familyId,
      commitmentKind: 'first_find',
      summary: FIRST_FIND_BEAT,
      dueAt: DUE_AT,
    });

    // The provenance is the SEND's own ledger row, never a compose: the id points at an
    // outbound channel_messages row that exists and went out.
    const carrier = journey.intake.fake
      .rows(schema.channelMessages)
      .find((row) => row.id === journey.promised.createdFrom);
    expect(carrier).toMatchObject({ direction: 'out', status: 'sent' });
  });
});

describe('an unkept promise is a queryable state', () => {
  it('reads as overdue once its clock has run out', () => {
    expect(journey.overdue).toEqual({
      overdueFamilies: 1,
      overdueCommitments: 1,
      openCommitments: 1,
    });
  });

  it('names the promise the family is waiting on, in the words Hale used', () => {
    expect(journey.open).toEqual([
      {
        id: expect.any(String),
        kind: 'first_find',
        summary: FIRST_FIND_BEAT,
        dueAt: DUE_AT,
        overdue: true,
      },
    ]);
  });
});

describe('the sweep pays it off', () => {
  it('finally has something real to send', () => {
    expect(journey.sweep).toMatchObject({ enabled: true, evaluated: 1, sent: 1 });
    expect(journey.sweepBodies).toHaveLength(1);
    expect(journey.sweepBodies[0]).toContain('Library story time');
  });

  it('closes the promise against the message that kept it', () => {
    const [row] = journey.intake.fake.rows(schema.agentCommitments);
    expect(row?.fulfilledAt).toEqual(NUDGE_AT);

    // SEAM: the fake applies no WHERE clause, so WHICH rows the closing UPDATE touches
    // is SQL-side (ledger.ts scopes it to this family, this kind, still open — proved in
    // lib/commitments/ledger.test.ts). What this store can see is the pairing, and the
    // pairing is the contract: what closed it is the nudge's own outbound row.
    const closer = journey.intake.fake
      .rows(schema.channelMessages)
      .find((message) => message.id === row?.fulfilledBy);
    expect(closer).toMatchObject({ category: 'nudge', direction: 'out', status: 'sent' });
  });
});
