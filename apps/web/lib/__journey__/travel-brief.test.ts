import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActivityPick, createActivityFinder } from '~/lib/channel/activity/lane';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { ActiveConnectorConnection } from '~/lib/integrations/store';
import { pipelineClient } from '~/lib/pipeline/client';
import { fetchGmailMessageBody } from '~/lib/sentinel';
import { type GoogleFetch, type SyncDeps, syncConnection } from '~/lib/integrations/sync';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { recordedModel } from '~/lib/testing/recorded-model';
import { detectTravelBookingsForSweep } from '~/lib/travel/detect';
import { extractTravelBooking } from '~/lib/travel/extract';
import { defaultTravelBriefDeps, runTravelBriefSweep } from '~/lib/travel/sweep';

/**
 * A BOOKING EMAIL BECOMES ONE TEXT, END TO END — the confirmation lands in a connected
 * Gmail, a trip is written down, and a week before they go the parent gets two things
 * that are on in New York.
 *
 * WHAT IS REAL HERE, and this is the whole point of the file:
 *
 *   · THE CONNECTOR SWEEP. `syncConnection` itself, over its real Gmail mapping, its real
 *     cursor discipline and its real per-pass boundaries. The travel detect port is the
 *     production one.
 *
 *   · `looksLikeBooking`. The pre-filter is a regex over the subject and the snippet, and
 *     it is the one stage that can fail TOTALLY AND SILENTLY: reject the subject and no
 *     model is called, no row is written, no counter says anything but
 *     `not_booking_shaped`, and every test that injects an extraction stays green. So the
 *     envelope here is the real one and the filter is never bypassed — which is what the
 *     mutation at the bottom proves.
 *
 *   · THE FINDER. `createActivityFinder` over a RECORDED model — the real
 *     de-identification, the real lane, the real two-phase turn. An injected fake
 *     `ActivityFinder` returning two picks could never fail on the lane's behaviour with a
 *     TRAVEL-SHAPED query, and that behaviour is the only new thing in the find leg: a
 *     destination in `town`, a window with no year, and a subject about a visit rather
 *     than a term.
 *
 *   · Everything else: the outbound chokepoint, the phone resolution, the claim, the
 *     ledger, the trip's terminal state, the audit rows — all production code over real
 *     Postgres.
 *
 * WHAT IS FAKED, and only this: the SMS transport and Gmail's HTTP. THE MODEL IS REAL AND
 * RECORDED (rule #8) — all three turns, the extraction and the finder's two, are replayed
 * from `__recordings__/travel-brief.json`, which is transcoded with no new model call from
 * the two eval corpora that already run them live: `travel-extract:airline-named-child`
 * and `activity-{ground,picks}:travel-visit-new-york`. That is why this file's envelope
 * carries the corpus's `from`, its `received_at` and its two child first names rather than
 * a convenient set of its own: a byte for byte difference is a different question, and a
 * recording must never answer one it was not asked. Edit the skill, the subject, the
 * window or the fixture body and the keys move, the eval goes red on `--cached-only` and
 * this file goes red with "no recording for key" until `mint-travel-brief.mjs` is re-run.
 *
 * WHAT THE RECORDING ACTUALLY SAYS, and it is not what a scripted stand-in would have
 * said: the real New York picks carry NO PRICE at all and the top one carries no `when`
 * either. A hand-written fixture would have handed the renderer two tidy admissions and
 * proved nothing about the null path that production will meet most days.
 *
 * THE MUTATION AT THE BOTTOM is the file's reason to exist: delete the booking noun from
 * the fixture's subject and the journey goes red at the TRIP ROW, because only a real
 * `looksLikeBooking` can catch that.
 */

const TZ = 'America/Toronto';
const PHONE = '+14165550401';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');
const INTEGRATION_ID = '77777777-7777-4777-8777-777777777777';

/** The eval corpus's own airline confirmation — the same envelope `airline-named-child`
 * grades, FIELD FOR FIELD, because the extraction below is that fixture's recorded answer
 * and a recording is keyed on the question. `from` and `receivedAt` are the corpus's, and
 * the household's first names are its `['Mia', 'Leo']` in that order. The snippet is this
 * file's own: it never reaches the model, only `looksLikeBooking`. */
const SUBJECT = 'Your itinerary for AC 704';
const FROM = 'Air Canada <noreply@aircanada.ca>';
const SNIPPET = 'Departure Toronto YYZ 07:45, boarding gate posted 40 minutes prior';
const CHILD_FIRST_NAMES = ['Mia', 'Leo'] as const;
const RECORDINGS = join(import.meta.dirname, '__recordings__', 'travel-brief.json');
const BODY = [
  'AIR CANADA - ELECTRONIC TICKET ITINERARY',
  '',
  'AC 704  Toronto Pearson (YYZ) -> New York LaGuardia (LGA)',
  'Departs Sat 12 Sep 2026 07:45   Arrives 09:10',
  '',
  'AC 711  New York LaGuardia (LGA) -> Toronto Pearson (YYZ)',
  'Departs Tue 15 Sep 2026 18:20   Arrives 20:05',
  '',
  'Passengers:',
  '  CHEN/SARAH MS        Seat 14A',
  '  CHEN/MIA MISS        Seat 14B',
  '',
  'Booking reference: QRT4LM',
  'Total charged: CAD 812.44',
].join('\n');

/** The confirmation lands on 1 September — the corpus's own `receivedAt`, to the
 * millisecond, because it is inside the question the recorded extraction answered. */
const RECEIVED_AT_MS = Date.parse('2026-09-01T14:12:00.000Z');
const SYNC_AT = new Date('2026-09-01T15:00:00.000Z');
/** T-7d, 09:00 Toronto — the first hourly tick inside the parent's waking window. */
const BRIEF_AT = new Date('2026-09-05T13:00:00.000Z');

let db: TestDb;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = APP_KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = APP_KEY;
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_ENABLED', 'true');
  vi.stubEnv('TRAVEL_BRIEF_FAMILY_ALLOWLIST', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await seed();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

async function seed(): Promise<void> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', areaCoarse: 'M4K', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;

  const [parent] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}@example.test`, name: 'Sarah', timezone: TZ })
    .returning({ id: schema.users.id });
  parentUserId = parent?.id as string;

  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: SYNC_AT,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: parentUserId,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    SYNC_AT,
  );
  // A four-year-old and her older brother — the corpus's household, and Mia is the one
  // the itinerary names. Both are under 13, so both are namable and the stage handed to
  // the search is the YOUNGEST's: preschool, which is the stage the finder fixture was
  // minted at.
  await db.database.insert(schema.children).values([
    { familyId, name: 'Mia', dateOfBirth: '2022-04-01' },
    { familyId, name: 'Leo', dateOfBirth: '2019-07-15' },
  ]);
}

/** Gmail's HTTP, and nothing else about the connector. */
function mailbox(subject: string): GoogleFetch {
  return async (url) => {
    if (url.includes('?format=full')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from(BODY, 'utf8').toString('base64url') },
          },
        }),
      };
    }
    if (url.includes('/messages/m-travel')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm-travel',
          snippet: SNIPPET,
          internalDate: String(RECEIVED_AT_MS),
          payload: {
            headers: [
              { name: 'Subject', value: subject },
              { name: 'From', value: FROM },
            ],
          },
        }),
      };
    }
    if (url.includes('/profile')) {
      return { ok: true, status: 200, json: async () => ({ historyId: '4002' }) };
    }
    if (url.includes('/history')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ messagesAdded: [{ message: { id: 'm-travel' } }] }],
          historyId: '4100',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm-travel' }] }) };
  };
}

/**
 * THE MODEL, RECORDED — one client for all three turns.
 *
 * `recordedModel` looks a turn up by a content address over the model, the system prompt
 * and the user message, so the SAME instance serves the extraction and the finder's two
 * turns without either being able to answer the other's question. `pipelineClient` is
 * passed as the live resolver and is never called: without `HALE_RECORD=1` a miss throws
 * with the key and the request printed, so CI can neither spend nor silently pass.
 *
 * `requests` is every user message that reached the wire, in order — the real projections,
 * which is what the border assertions below read.
 */
function model() {
  return recordedModel(RECORDINGS, pipelineClient);
}

/** The picks the recorded finder turn actually returns, read out of the recording so the
 * body assertions are about the RENDERER carrying the model's own words rather than about
 * a set of words this file chose. */
function recordedPicks(): ActivityPick[] {
  const recordings = JSON.parse(readFileSync(RECORDINGS, 'utf8')) as Record<
    string,
    { response: { content: Array<{ type: string; name?: string; input?: unknown }> } }
  >;
  for (const entry of Object.values(recordings)) {
    const block = entry.response.content.find(
      (b) => b.type === 'tool_use' && b.name === 'activity_picks',
    );
    if (!block) continue;
    const input = block.input as {
      picks: Array<{
        name: string;
        age_fit: string;
        when?: string;
        price?: string;
        source_name: string;
      }>;
    };
    return input.picks.map((pick) => ({
      name: pick.name,
      ageFit: pick.age_fit,
      when: pick.when ?? null,
      price: pick.price ?? null,
      sourceName: pick.source_name,
      source: 'web' as const,
    }));
  }
  throw new Error('the travel-brief recording carries no activity_picks turn');
}

function connection(): ActiveConnectorConnection {
  return {
    id: INTEGRATION_ID,
    familyId,
    userId: parentUserId,
    provider: 'gmail',
    providerMetadata: { historyId: '4002' },
    tokens: { accessToken: 'ya29.journey' },
  };
}

/** The real sync deps. Only Google's HTTP and the queue are ports; the travel detect pass
 * is the production one, wired to the production extractor over the recorded model. */
function syncDeps(subject: string, recorded: ReturnType<typeof model>): SyncDeps {
  const googleFetch = mailbox(subject);
  return {
    googleFetch,
    enqueue: async () => {},
    childNames: [...CHILD_FIRST_NAMES],
    saveCursor: async () => {},
    markError: async () => {
      throw new Error('the connection must not be marked errored in this journey');
    },
    refreshTokens: async () => ({ accessToken: 'ya29.journey' }),
    saveTokens: async () => {},
    alertGmailEnvelopes: async (batch) =>
      batch.envelopes.map(() => ({ alert: 'dark' as const, booking: null, going: null, aside: null })),
    alertCalendarChanges: async () => ({ changes: [], reoffers: [], asides: [] }),
    detectTravelBookings: async (batch) =>
      detectTravelBookingsForSweep(
        db.database,
        {
          familyId: batch.connection.familyId,
          parentUserId: batch.connection.userId,
          integrationId: batch.connection.id,
          seeding: batch.seeding,
          envelopes: batch.envelopes,
          now: SYNC_AT,
        },
        {
          // The REAL on-demand body reader, over the same fake HTTP the envelope came
          // through — so the base64url decode and the multipart walk are production code
          // here too.
          fetchBody: (messageId) =>
            fetchGmailMessageBody(messageId, batch.accessToken, googleFetch),
          extract: (input) => extractTravelBooking(input, recorded.client()),
          childFirstNames: async () => [...CHILD_FIRST_NAMES],
          householdNames: async () => [...CHILD_FIRST_NAMES, 'Sarah'],
          timeZone: async () => TZ,
        },
      ),
  };
}

async function runSync(subject = SUBJECT) {
  const recorded = model();
  const sync = await syncConnection(connection(), syncDeps(subject, recorded));
  return { sync, requests: recorded.requests };
}

async function runBrief() {
  const sent: Array<{ to: string; body: string }> = [];
  const web = model();
  const result = await runTravelBriefSweep(
    db.database,
    {
      ...defaultTravelBriefDeps(),
      // THE REAL FINDER over a RECORDED model. An injected fake could never fail on the
      // lane's behaviour with a travel-shaped query, and that is the only new thing here.
      finder: createActivityFinder(web.client),
      buildGate: (database) => buildOutboundGatePorts(database),
      resolvePhone: async () => PHONE,
      transport: {
        send: async (input) => {
          sent.push(input);
          return { providerMessageId: `prov-${sent.length}` };
        },
      },
    },
    BRIEF_AT,
  );
  // The de-identified SEARCH payload, picked out of everything that reached the wire by
  // the one field only it carries. The compose turn that follows it is excluded by
  // `research_notes`, which holds the page text and is a different disclosure.
  const searched = web.requests.filter(
    (request) => request.includes('"town"') && !request.includes('research_notes'),
  );
  return { result, sent, searched };
}

describe('a booking email becomes one text a week before the trip', () => {
  it('writes the trip on the sweep, and texts it at T-7d', async () => {
    // ── the connector sweep, for real ────────────────────────────────────────
    const { sync, requests } = await runSync();
    expect(sync.travelDetections).toEqual(['trip_written']);

    const [trip] = await db.database.select().from(schema.familyTrips);
    expect(trip).toMatchObject({
      familyId,
      parentUserId,
      destinationCity: 'New York',
      destinationRegion: 'NY',
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      childEvidence: 'named_traveller',
      closedAt: null,
    });
    // Nothing the confirmation said survived: no body, no reference, no fare, no
    // passenger line. Asserted over the whole serialised row rather than a field list.
    const row = JSON.stringify(trip);
    for (const forbidden of ['QRT4LM', '812', 'CHEN', 'AC 704', 'Seat']) {
      expect(row, `the trip row must not carry ${forbidden}`).not.toContain(forbidden);
    }

    // Nothing has been sent. The detect pass writes a row and two kinds of audit line;
    // the text is a different sweep four days later.
    expect(await db.database.select().from(schema.channelMessages)).toHaveLength(0);

    // WHAT CROSSED THE BORDER ON LEG ONE, said plainly rather than left to a comment. The
    // extraction is handed the booking's BODY and the children's FIRST NAMES, because
    // `named_traveller` is a string match and there is no way to derive it without them.
    // It is handed no age and no id. One call, and only one.
    expect(requests).toHaveLength(1);
    const extractionLeg = requests[0] ?? '';
    expect(extractionLeg).toContain('CHEN/MIA MISS');
    expect(extractionLeg).toContain('"household_child_first_names":["Mia","Leo"]');
    expect(extractionLeg).not.toContain('ageInMonths');
    expect(extractionLeg).not.toContain(parentUserId);

    // ── T-7d: the hourly nudge leg ───────────────────────────────────────────
    const { result, sent, searched } = await runBrief();
    expect(result.sent).toBe(1);
    expect(result.due).toBe(1);

    // THE QUERY THAT CROSSED THE BORDER. The window survived `scrubResidualPii` with its
    // dates intact — which is the whole reason it is composed without a year — and the
    // subject asked about a VISIT rather than a term.
    expect(searched).toHaveLength(1);
    const query = searched[0] ?? '';
    expect(query).toContain('New York, NY');
    expect(query).toContain('September 12 to 15');
    expect(query).not.toContain('[redacted]');
    expect(query).not.toContain('2026');
    // And leg two carries none of what leg one did: no name, no body, no booking. The
    // extraction assertion above is this one's positive control — the same recorder saw
    // both, and it saw 'Mia' on exactly one of them.
    for (const forbidden of ['Mia', 'Leo', 'QRT4LM', 'AC 704', 'CHEN']) {
      expect(query, `the search query must not carry ${forbidden}`).not.toContain(forbidden);
    }

    // THE FAR SIDE: one text, on the connecting parent's phone.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(PHONE);
    const body = sent[0]?.body ?? '';
    expect(body).toContain("You're in New York the 12th to the 15th");
    // Both children are under 13, so both are named; neither age is.
    expect(body).toContain('for Mia and Leo');
    expect(body).not.toMatch(/\b(4|7)\b/);

    // THE PICKS ARE THE MODEL'S OWN, read out of the recording rather than typed here —
    // so this is a claim about the RENDERER carrying what the lane found, not about a set
    // of words this file chose. Two of the three are rendered and the third is dropped
    // WHOLE (SLOTS_IN_TEXT), which is the never-a-directory rule on real output.
    const picks = recordedPicks();
    expect(picks).toHaveLength(3);
    expect(body).toContain(picks[0]?.name);
    expect(body).toContain(picks[1]?.name);
    expect(body).not.toContain(picks[2]?.name);

    // NOTHING WAS INVENTED, and the pair is what makes that a claim rather than a hope.
    // The live New York turn published NO price for either pick — the null path the
    // product will meet most days — so no currency may appear in the body; and the second
    // pick's `when` DID come back, so its own figures must, or the absence above would
    // only be proving that the renderer drops everything.
    expect(picks[0]?.price).toBeNull();
    expect(picks[1]?.price).toBeNull();
    expect(body).not.toMatch(/\$|USD|CAD|EUR|GBP/);
    expect(body).toContain(picks[1]?.when);

    // It claims nothing about anyone having been, and it asks nothing.
    expect(body).toContain("not from anyone who's been");
    expect(body).not.toContain('?');
    expect(body).toContain('Reply STOP');

    // The trip closed exactly once, carried by the message the parent got.
    const [closed] = await db.database.select().from(schema.familyTrips);
    expect(closed?.closedReason).toBe('sent');
    expect(closed?.closedAt).not.toBeNull();
    const [message] = await db.database
      .select({ id: schema.channelMessages.id, dedupeKey: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.category, 'travel_brief'));
    expect(closed?.briefChannelMessageId).toBe(message?.id);
    expect(message?.dedupeKey).toBe(`travel_brief:${trip?.id}`);

    // One audit row of each verb, both enum-and-count only.
    const allAudit = await db.database
      .select({ verb: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog);
    // The seed's own watch-consent row is in this table too; the claim is about the two
    // verbs this feature writes, and that there is not a third.
    const audit = allAudit.filter((entry) => entry.verb.startsWith('travel_'));
    expect(audit.map((entry) => entry.verb).sort()).toEqual([
      'travel_brief_sent',
      'travel_trip_noticed',
    ]);
    expect(audit.find((e) => e.verb === 'travel_trip_noticed')?.after).toEqual({
      childEvidence: 'named_traveller',
      nights: 3,
    });
    expect(audit.find((e) => e.verb === 'travel_brief_sent')?.after).toEqual({
      picks: 2,
      merged: 0,
    });
    expect(JSON.stringify(audit)).not.toContain('New York');

    // And a second tick in the same hour sends nothing: the trip is closed.
    const again = await runBrief();
    expect(again.sent).toEqual([]);
    expect(again.result.due).toBe(0);
  });

  /**
   * THE MUTATION THIS FILE EXISTS FOR.
   *
   * Take the booking noun out of the subject and the pre-filter rejects the envelope. No
   * model is called, no row is written, and the only thing that says so is a counter.
   * Every test below the filter — the extraction's schema tests, the detect pglite tests
   * that hand in an extraction, the sweep's whole suite — stays green, because every one
   * of them starts after this stage. Only the real `looksLikeBooking`, over the real
   * envelope the real Gmail mapping produced, can catch it.
   */
  it('goes red at the trip row when the subject loses its booking noun', async () => {
    const { sync, requests } = await runSync('AC 704 tomorrow morning');
    expect(sync.travelDetections).toEqual(['not_booking_shaped']);
    // NO MODEL WAS CALLED AT ALL. The pre-filter is free and it is the whole cost guard:
    // a rejected envelope never becomes a body fetch, never crosses the border, and never
    // appears on a bill. The positive control is the passing run above, which made one.
    expect(requests).toEqual([]);
    expect(await db.database.select().from(schema.familyTrips)).toHaveLength(0);

    // Nothing to brief, and nothing sent.
    const { result, sent } = await runBrief();
    expect(result.due).toBe(0);
    expect(sent).toEqual([]);
  });
});
