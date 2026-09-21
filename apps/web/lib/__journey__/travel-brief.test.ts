import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { ActiveConnectorConnection } from '~/lib/integrations/store';
import { fetchGmailMessageBody } from '~/lib/sentinel';
import { type GoogleFetch, type SyncDeps, syncConnection } from '~/lib/integrations/sync';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
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
 *   · THE FINDER. `createActivityFinder` over a scripted model and fixture search results
 *     — the `activity-answered.test.ts` convention, "the real de-identification, the real
 *     lane. Only the WEB is a port". An injected fake `ActivityFinder` returning two picks
 *     could never fail on the lane's behaviour with a TRAVEL-SHAPED query, and that
 *     behaviour is the only new thing in the find leg: a destination in `town`, a window
 *     with no year, and a subject about a visit rather than a term.
 *
 *   · Everything else: the outbound chokepoint, the phone resolution, the claim, the
 *     ledger, the trip's terminal state, the audit rows — all production code over real
 *     Postgres.
 *
 * WHAT IS FAKED, and only this: the SMS transport, Gmail's HTTP, and the model's WORDS.
 * The extraction is a scripted client rather than a recorded one because its quality is
 * the eval's job (rule #8, `apps/worker/evals/run-travel-extract-eval.mjs`, 14 fixtures
 * over real cached Claude) and what this file is for is everything AROUND it.
 *
 * THE MUTATION AT THE BOTTOM is the file's reason to exist: delete the booking noun from
 * the fixture's subject and the journey goes red at the TRIP ROW, because only a real
 * `looksLikeBooking` can catch that.
 */

const TZ = 'America/Toronto';
const PHONE = '+14165550401';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');
const INTEGRATION_ID = '77777777-7777-4777-8777-777777777777';

/** The eval corpus's own airline confirmation — the same body `airline-named-child`
 * grades, so the journey and the quality gate read the same email. */
const SUBJECT = 'Your itinerary for AC 704';
const SNIPPET = 'Departure Toronto YYZ 07:45, boarding gate posted 40 minutes prior';
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

/** The confirmation lands on 1 September. */
const RECEIVED_AT_MS = Date.parse('2026-09-01T12:00:00.000Z');
const SYNC_AT = new Date('2026-09-01T13:00:00.000Z');
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
  // A four-year-old — the beachhead stage, and the child named on the itinerary.
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2022-04-01' });
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
              { name: 'From', value: 'Air Canada <noreply@aircanada.example>' },
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

/** The extraction client: the forced tool answers what a human reading that email would
 * conclude — the same expectation the eval's `airline-named-child` fixture grades. */
function extractionClient(): AgentClient {
  return {
    messages: {
      // biome-ignore lint/suspicious/noExplicitAny: a scripted stand-in for the model
      async create(_req: any) {
        return {
          content: [
            {
              type: 'tool_use',
              name: 'travel_booking',
              input: {
                destination_city: 'New York',
                destination_region: 'NY',
                start_date: '2026-09-12',
                end_date: '2026-09-15',
                child_evidence: 'named_traveller',
                confidence: 0.95,
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
          stop_reason: 'tool_use',
        };
      },
    },
  } as unknown as AgentClient;
}

/**
 * The client the LANE drives: a real grounded turn shape (a `web_search_tool_result` with
 * real result items, which is what the lane's grounding invariant counts) followed by a
 * real forced-tool extraction. Only the CONTENT is a fixture — everything the lane does
 * with it is production code.
 */
function webPort(): { client: () => AgentClient; searched: string[] } {
  const searched: string[] = [];
  const client = () =>
    ({
      messages: {
        // biome-ignore lint/suspicious/noExplicitAny: a fixture standing in for the web
        async create(req: any) {
          if (req.tool_choice?.name === 'activity_picks') {
            return {
              content: [
                {
                  type: 'tool_use',
                  name: 'activity_picks',
                  input: {
                    picks: [
                      {
                        name: 'American Museum of Natural History',
                        age_fit: 'all ages, under 2 free',
                        when: 'open daily 10am-5:30pm',
                        price: 'USD 28 adults / 16 kids',
                        source_name: 'American Museum of Natural History',
                      },
                      {
                        name: 'Central Park Zoo',
                        age_fit: 'all ages',
                        when: '10am-5pm daily',
                        price: 'USD 20',
                        source_name: 'Central Park Zoo',
                      },
                    ],
                  },
                },
              ],
              usage: { input_tokens: 10, output_tokens: 10 },
              stop_reason: 'tool_use',
            };
          }
          searched.push(req.messages?.[0]?.content as string);
          return {
            content: [
              { type: 'text', text: 'Read the visitor pages for hours and admission.' },
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtu_1',
                content: [
                  {
                    type: 'web_search_result',
                    url: 'https://venue.example/visit',
                    title: 'Plan your visit',
                    encrypted_content: 'x',
                    page_age: null,
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: 'end_turn',
          };
        },
      },
    }) as unknown as AgentClient;
  return { client, searched };
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
 * is the production one, wired to the production extractor over a scripted client. */
function syncDeps(subject: string): SyncDeps {
  const googleFetch = mailbox(subject);
  return {
    googleFetch,
    enqueue: async () => {},
    childNames: ['Mia'],
    saveCursor: async () => {},
    markError: async () => {
      throw new Error('the connection must not be marked errored in this journey');
    },
    refreshTokens: async () => ({ accessToken: 'ya29.journey' }),
    saveTokens: async () => {},
    alertGmailEnvelopes: async (batch) =>
      batch.envelopes.map(() => ({ alert: 'dark' as const, booking: null })),
    alertCalendarChanges: async () => ({ changes: [], reoffers: [] }),
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
          extract: (input) => extractTravelBooking(input, extractionClient()),
          childFirstNames: async () => ['Mia'],
          householdNames: async () => ['Mia', 'Sarah'],
          timeZone: async () => TZ,
        },
      ),
  };
}

async function runSync(subject = SUBJECT) {
  return syncConnection(connection(), syncDeps(subject));
}

async function runBrief() {
  const sent: Array<{ to: string; body: string }> = [];
  const web = webPort();
  const result = await runTravelBriefSweep(
    db.database,
    {
      ...defaultTravelBriefDeps(),
      // THE REAL FINDER over a scripted model. An injected fake could never fail on the
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
  return { result, sent, searched: web.searched };
}

describe('a booking email becomes one text a week before the trip', () => {
  it('writes the trip on the sweep, and texts it at T-7d', async () => {
    // ── the connector sweep, for real ────────────────────────────────────────
    const sync = await runSync();
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
    expect(query).not.toContain('Mia');

    // THE FAR SIDE: one text, on the connecting parent's phone.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(PHONE);
    const body = sent[0]?.body ?? '';
    expect(body).toContain("You're in New York the 12th to the 15th");
    expect(body).toContain('American Museum of Natural History');
    expect(body).toContain('Central Park Zoo');
    // Both figures came off a page, and nothing was invented beside them.
    expect(body).toContain('USD 28 adults / 16 kids');
    expect(body).toContain('USD 20');
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
    const sync = await runSync('AC 704 tomorrow morning');
    expect(sync.travelDetections).toEqual(['not_booking_shaped']);
    expect(await db.database.select().from(schema.familyTrips)).toHaveLength(0);

    // Nothing to brief, and nothing sent.
    const { result, sent } = await runBrief();
    expect(result.due).toBe(0);
    expect(sent).toEqual([]);
  });
});
