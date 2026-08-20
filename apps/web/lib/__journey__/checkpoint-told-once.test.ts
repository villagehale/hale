import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { createIntakeAckComposer } from '~/lib/channel/intake/intake-voice';
import { createRadarComposer, readCandidates, readWindows } from '~/lib/channel/intake/radar';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type NudgeRunDeps, type NudgeRunResult, runNudgeCron } from '~/lib/channel/nudge/run';
import { checkpointById, checkpointRef } from '~/lib/health/checkpoints';
import { checkpointToldKey, checkpointToldKeyPrefix } from '~/lib/health/told';
import { defaultCheckupOfferPorts, recordCheckupOffer } from '~/lib/health/offer';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { fakeWeather } from '~/lib/weather/open-meteo';

/**
 * TOLD BY ANY SURFACE — the cross-surface half of M8's suppression.
 *
 * The defect this file exists for: VIL-243/238 gave the intake radar a third rung, so
 * the FIRST message a geo-empty family ever gets can carry a health checkpoint. M8's
 * 48h nudge asks "has this family been told about this checkpoint?" — and it asked a
 * reader that could only see the nudge's OWN sends. Two days after hearing that
 * Ontario schedules a visit at six months, the same family heard it again, from the
 * same number, in the same words. Exactly the cohort the cascade was built for.
 *
 * So the two surfaces are driven here in sequence, over one store: the REAL intake
 * machine and the REAL radar composer (on `client: null`, the production deterministic
 * path — rule #8), then the REAL nudge sweep 48 hours later.
 *
 * SEAM discipline is the toddler journey's (lib/__journey__/toddler-journey.test.ts):
 * the fake database does not evaluate WHERE clauses, so each loader below restates the
 * predicate its production SQL applies and names the module that owns it.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const PARENT_PHONE = '+14165550100';
const TZ = 'America/Toronto';
/** Halton Hills: outside civic-adapter coverage, no registration windows, nothing
 * discovered yet. The geography is empty and the age is not — the cascade's cohort. */
const AREA = 'L7G';
/** Friday 10:00 Toronto — the parent texts in. */
const INTAKE_AT = new Date('2026-07-31T14:00:00.000Z');
/** Sunday 10:00 Toronto, 48 hours on — this family's nudge slot. */
const NUDGE_AT = new Date('2026-08-02T14:00:00.000Z');

/**
 * Six months old at intake and still six months old at the sweep. Deliberate: exactly
 * ONE Ontario row admits a six-month-old, so "did the nudge repeat the radar" has a
 * yes/no answer rather than a "which of the two 18-month rows" answer.
 */
const MIA = { name: 'Mia', ageMonths: 6, agePrecision: 'months' } as const;
const CHECKPOINT_ID = 'immunization_6_months';

function taskOf(checkpointId: string): string {
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint) throw new Error(`fixture drift: no checkpoint '${checkpointId}'`);
  return checkpoint.task;
}

function refFor(checkpointId: string, childId: string): string {
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint) throw new Error(`fixture drift: no checkpoint '${checkpointId}'`);
  return checkpointRef(checkpoint, childId, 0);
}

// ── surface 1 · the intake radar ─────────────────────────────────────────────

interface Intake {
  fake: FakeDb;
  transport: FakeTransport;
  familyId: string;
  childId: string;
  /** The message the radar actually sent, watch offer and all. */
  radarBody: string;
}

async function runIntakeRadar(): Promise<Intake> {
  const fake = makeFakeDb();
  const transport = new FakeTransport();

  const deps: IntakeDeps = {
    transport,
    extractor: new FakeExtractor([{ children: [MIA], postalCode: AREA }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes please', interpretation: 'a clear yes' },
    ]),
    // The REAL composer on the REAL production fallback path: `client: null` renders
    // deterministically (radar-voice.ts), so the words asserted below are the words a
    // family gets when voice is unavailable — no model decides anything here.
    radar: createRadarComposer({
      database: fake.db,
      weather: fakeWeather([]),
      client: null,
      now: () => INTAKE_AT,
      timeZone: TZ,
    }),
    // Nothing to seed and nowhere to place them: this family's whole point is that
    // geography has nothing for them yet.
    seedCivic: async () => 0,
    resolveCenter: async () => null,
    discoveryTrigger: () => {},
    ackComposer: createIntakeAckComposer(null),
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => INTAKE_AT.getTime()),
    now: INTAKE_AT,
  };

  const text = (body: string) =>
    handleInboundSms(fake.db, transport.inbound(PARENT_PHONE, body), deps);

  await text('hi');
  const provisioned = await text('Mia is 6 months, we are at L7G');
  const familyId = 'familyId' in provisioned ? (provisioned.familyId as string) : '';
  const radarBody = transport.bodies().at(-1) as string;
  await text('yes please');

  const childId = fake.rows(schema.children)[0]?.id as string;
  return { fake, transport, familyId, childId, radarBody };
}

// ── surface 2 · the 48h nudge ────────────────────────────────────────────────

/** The gate is not what this file tests — the toddler journey drives its four real
 * ports against real rows. Here it says yes, so a suppressed checkpoint is the only
 * thing that can keep the sweep quiet. */
const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => false,
  parentTimeZone: async () => TZ,
});

function nudgeDeps(fake: FakeDb, transport: FakeTransport, familyId: string): NudgeRunDeps {
  return {
    /** SEAM: prod selects with families ⋈ family_members ⋈ users (run.ts
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
    /** SEAM: the real reader is TOLD ∪ DONE (health/reply.ts). TOLD is a LIKE over the
     * ledger's told-markers — every outbound row that carries one, whatever surface
     * wrote it (health/told.ts loadToldCheckpointRefs). Nothing is done here. */
    loadSuppressedCheckpoints: async () => {
      const prefix = checkpointToldKeyPrefix(familyId);
      return new Set(
        fake
          .rows(schema.channelMessages)
          .filter(
            (row) =>
              row.direction === 'out' &&
              ['queued', 'sent', 'delivered'].includes(String(row.status)),
          )
          .map((row) => String(row.dedupeKey ?? ''))
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length)),
      );
    },
    loadClaimedWindowIds: async () => new Set<string>(),
    weather: fakeWeather([]),
    buildGate: openGate,
    // SEAM: the ledger's dedupe predicate (channel/ledger.ts dedupeActive).
    dedupeActive: async (_database, key) =>
      fake
        .rows(schema.channelMessages)
        .some(
          (row) =>
            row.dedupeKey === key && ['queued', 'sent', 'delivered'].includes(String(row.status)),
        ),
    resolveSendablePhone: async () => PARENT_PHONE,
    recordSend: async (database, write) => {
      const [row] = (await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' } as never)
        .returning({ id: schema.channelMessages.id })) as Array<{ id: string }>;
      if (!row) throw new Error('told-once: channel_messages insert returned no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    transport,
    client: null,
    // MEM-10 · the REAL writer over the same store (this family was promised nothing,
    // so the honest outcome here is the ledger's `none_open`).
    fulfillCommitment,
    // The REAL offer writer over the same store: a health nudge whose task is booking
    // registers the standing question its own close makes (lib/health/offer.ts).
    recordCheckupOffer: (database, input) =>
      recordCheckupOffer(database, input, defaultCheckupOfferPorts()),
  };
}

function nudgeBodies(transport: FakeTransport, from: number): string[] {
  return transport.bodies().slice(from);
}

// ── the two runs ─────────────────────────────────────────────────────────────

interface Told {
  intake: Intake;
  sweep: NudgeRunResult;
  sweepBodies: string[];
}

let told: Told;
/** The inverse: nobody told this family anything, so the nudge must. */
let untold: { fake: FakeDb; sweep: NudgeRunResult; bodies: string[] };

/**
 * A family the radar never spoke to — the web-onboarding path, which provisions the
 * same rows and never composes a radar. The guard against a suppression that silences
 * the checkpoint for everyone.
 */
async function seedWithoutRadar(): Promise<{ fake: FakeDb; familyId: string }> {
  const fake = makeFakeDb();
  const [user] = (await fake.db
    .insert(schema.users)
    .values({ email: 'quiet@example.com', name: 'Quiet Parent', timezone: TZ } as never)
    .returning()) as Array<{ id: string }>;
  const [family] = (await fake.db
    .insert(schema.families)
    .values({ name: 'Quiet Family', areaCoarse: AREA, onboardingStage: 'sms_active' } as never)
    .returning()) as Array<{ id: string }>;
  await fake.db.insert(schema.children).values({
    familyId: family?.id,
    name: MIA.name,
    // The same six-month-old, as a stored row: the age comes out of the date.
    dateOfBirth: '2026-01-31',
    dobPrecision: 'derived',
  } as never);
  if (!user || !family) throw new Error('told-once: seed insert returned no row');
  return { fake, familyId: family.id };
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('F14_ENABLED', 'true');

  const intake = await runIntakeRadar();
  const before = intake.transport.sent.length;
  const sweep = await runNudgeCron(
    intake.fake.db,
    nudgeDeps(intake.fake, intake.transport, intake.familyId),
    NUDGE_AT,
  );
  told = { intake, sweep, sweepBodies: nudgeBodies(intake.transport, before) };

  const seeded = await seedWithoutRadar();
  const transport = new FakeTransport();
  const quietSweep = await runNudgeCron(
    seeded.fake.db,
    nudgeDeps(seeded.fake, transport, seeded.familyId),
    NUDGE_AT,
  );
  untold = { fake: seeded.fake, sweep: quietSweep, bodies: transport.bodies() };
});

afterAll(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('the radar tells a checkpoint', () => {
  it('says the reviewed row out loud, in the first message this family ever gets', () => {
    expect(told.intake.radarBody).toContain('Mia');
    expect(told.intake.radarBody).toContain(taskOf(CHECKPOINT_ID));
  });

  it('marks it told once, on the ledger, and only after the message has gone', () => {
    // The marker is the checkpoint's own identity, and it is written against the row the
    // SEND wrote — never against a compose. A message built and dropped tells nobody.
    const marker = checkpointToldKey(
      told.intake.familyId,
      refFor(CHECKPOINT_ID, told.intake.childId),
    );
    const writes = told.intake.fake.writes;
    const marks = writes.filter(
      (write) =>
        write.op === 'update' &&
        write.table === schema.channelMessages &&
        write.payload.dedupeKey === marker,
    );
    expect(marks).toHaveLength(1);

    // SEAM: the fake applies no WHERE clause, so WHICH row the mark lands on is
    // SQL-side (told.ts scopes it to the id sendAndRecord handed back). What this store
    // can see is the ORDER, and the order is the contract: the outbound row exists — an
    // SMS is born 'queued', the receipt advances it (channel/ledger.ts) — before
    // anything claims this family has been told.
    const markIndex = writes.indexOf(marks[0] as (typeof writes)[number]);
    const carrier = writes
      .slice(0, markIndex)
      .filter((write) => write.op === 'insert' && write.table === schema.channelMessages)
      .at(-1);
    expect(carrier?.payload).toMatchObject({
      direction: 'out',
      category: 'intake',
      status: 'queued',
    });
  });
});

describe('the 48h nudge does not repeat it', () => {
  it('finds nothing left worth saying, and says nothing', () => {
    expect(told.sweep).toMatchObject({ enabled: true, evaluated: 1, sent: 0, quiet: 1 });
    expect(told.sweepBodies).toEqual([]);
  });

  it('never sends the same checkpoint sentence twice', () => {
    for (const body of told.sweepBodies) {
      expect(body).not.toContain(taskOf(CHECKPOINT_ID));
    }
    const audits = told.intake.fake
      .rows(schema.auditLog)
      .filter((row) => row.actionTaken === 'proactive_nudge_sent');
    expect(audits).toEqual([]);
  });
});

describe('a family no surface has told still hears it', () => {
  it('sends the checkpoint the radar never carried', () => {
    expect(untold.sweep).toMatchObject({ enabled: true, evaluated: 1, sent: 1, quiet: 0 });
    expect(untold.bodies).toHaveLength(1);
    expect(untold.bodies[0]).toContain(taskOf(CHECKPOINT_ID));
    const audit = untold.fake
      .rows(schema.auditLog)
      .find((row) => row.actionTaken === 'proactive_nudge_sent');
    expect((audit?.after as Record<string, unknown>)?.checkpointId).toBe(CHECKPOINT_ID);
  });

  it('is the same six-month-old the radar family had, read off the stored date', () => {
    const child = untold.fake.rows(schema.children)[0] as Record<string, unknown>;
    expect(ageInMonths(child.dateOfBirth as string, NUDGE_AT)).toBe(6);
  });
});
