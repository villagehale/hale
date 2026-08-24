import { join } from 'node:path';
import type { AgentClient, RunAgentArgs, RunAgentResult } from '@hale/agent';
import { invokeTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { DeepResearchPayload } from '@hale/tools-contracts';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelActivityPromise } from '~/lib/channel/activity/commitment';
import { type DeepJobDeps, runDeepResearchJob } from '~/lib/channel/activity/deep-job';
import type { DeepLaneDeps } from '~/lib/channel/activity/deep-lane';
import { createFollowUpComposer } from '~/lib/channel/activity/followup-note';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { defaultActivitySharePorts, mintActivitySharePage } from '~/lib/channel/activity/share-page';
import { channelCoachRuntime } from '~/lib/channel/coach/runtime';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { refuseUnbackedSend } from '~/lib/channel/reconcile/gate';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import { type ReplyResolver, toReading } from '~/lib/channel/router/resolve';
import { channelRouterDeps } from '~/lib/channel/router/wiring';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { searchVillageTool } from '~/lib/coach/tools';
import { encryptString } from '~/lib/crypto/string-cipher';
import { pipelineClient } from '~/lib/pipeline/client';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type RecordedModel, recordedModel } from '~/lib/testing/recorded-model';

/**
 * TWO MESSAGES, ONE QUESTION — the whole arc, over real Postgres.
 *
 * A parent names a gym at 19:40 and asks when the fall term starts.
 *
 *   MESSAGE ONE, at 19:40. The inline coach turn answers with what a search engine chose
 *   to show a thirty-second turn, and says Hale will go and read their schedule. That
 *   sentence becomes a ROW at send time (#532), against the outbound message that carried
 *   it — and, because the subject names a place, a deep.research JOB keyed to that row.
 *
 *   MESSAGE TWO, four minutes later. The drain runs the job: three concurrent research
 *   legs, an Opus merge, an adversarial refutation, and the existing follow-up composer.
 *   It lands in the SAME thread, and the promise closes against it.
 *
 * WHAT IS FAKED, and only this: the SMS transport, the WEB, and the model's WORDS. The
 * tool CALLS are real invocations through the guarded invoker, the ledger is real
 * Postgres with the committed migration chain, the refutation is production code running
 * on the fixture pages, and the follow-up text is REAL CLAUDE recorded once by content
 * address (rule #8) — so a change to the projection the composer reads misses the
 * recording and fails rather than replaying an answer to a different question.
 *
 * THE SECOND HALF OF THE FILE IS THE ONE THAT MATTERS MOST. When the deep pass cannot
 * run, nothing is sent, the row stays OPEN, and the hourly sweep keeps the promise the
 * way it always did. The new lane is an optimisation, and an optimisation that can lose a
 * promise is worse than not having built it.
 */

const TZ = 'America/Toronto';
/** Georgetown, Halton Hills — the incident family's real FSA. */
const AREA = 'L7G';
const PHONE = '+14165550100';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

/** Real Claude follow-up turns, recorded once. Re-record with HALE_RECORD=1. */
const RECORDINGS = join(import.meta.dirname, '__recordings__', 'deep-answer.json');

const TURN_AT = new Date('2026-08-24T23:40:00.000Z');
/** The drain tick that picks the job up — the next minute, in practice. */
const JOB_AT = new Date('2026-08-24T23:44:00.000Z');

/** 18 months — a toddler, the beachhead stage. */
const CHILD_DOB = '2025-02-20';

const VENUE_PAGE = 'https://cartwheelsgymcentre.example/programs';
const TOWN_PAGE = 'https://haltonhills.example/recreation/registration';

/** What the two legs that opened pages actually read. The refutation checks the merge's
 * quotes against THESE STRINGS, so a fabricated fact cannot survive the journey. */
const VENUE_TEXT =
  'Fall block runs Sept 14 to Oct 26.\nTiny Gym | Sun | 9:30-10:15 AM | walking to 3.5 years\nTiny Gym (10 wks) .......... $124.00';
const TOWN_TEXT =
  'Fall registration opens Tuesday, July 22 at 7:00 a.m. for Halton Hills residents.';

describe('the deep answer arrives at question time', () => {
  let db: TestDb;
  let database: Database;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);

    const [family] = await database
      .insert(schema.families)
      .values({
        displayName: 'Test family',
        provinceOrState: 'ON',
        areaCoarse: AREA,
        onboardingStage: 'sms_active',
      })
      .returning({ id: schema.families.id });
    familyId = (family as { id: string }).id;

    const [user] = await database
      .insert(schema.users)
      .values({ email: null, name: null, timezone: TZ })
      .returning({ id: schema.users.id });
    parentUserId = (user as { id: string }).id;

    await database
      .insert(schema.familyMembers)
      .values({ familyId, userId: parentUserId, role: 'primary_parent' });
    await database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: `hash-${parentUserId}`,
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await database
      .insert(schema.children)
      .values({ familyId, name: 'Noah', dateOfBirth: CHILD_DOB });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  // ── the web, as a port ─────────────────────────────────────────────────────

  /** The INLINE lane's client: a grounded turn, then a forced extraction with a hole in
   * it — no price, which is what a snippet search comes back with and what makes the
   * turn owe depth. */
  function inlineWeb(): () => AgentClient {
    return () =>
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
                          name: 'Tiny Gym, Cartwheels Gym Centre',
                          age_fit: 'walking to 3.5 years',
                          when: 'Sundays, fall block',
                          price: null,
                          source_name: 'Cartwheels Gym Centre',
                        },
                      ],
                    },
                  },
                ],
                usage: { input_tokens: 10, output_tokens: 10 },
                stop_reason: 'tool_use',
              };
            }
            return {
              content: [
                { type: 'text', text: 'Their programs page lists a fall block.' },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: 'srvtu_1',
                  content: [
                    {
                      type: 'web_search_result',
                      url: VENUE_PAGE,
                      title: 'Programs',
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
  }

  /**
   * THE DEEP LANE'S TWO PORTS. The fan-out's three legs and the merge's words are
   * fixtures; `runDeepLane` — the settle-per-leg, the merge call and the whole refutation
   * — is production code running for real on these bytes.
   */
  function deepLane(
    options: { legsFail?: boolean; poison?: boolean } = {},
  ): DeepLaneDeps & { merged: unknown[] } {
    const merged: unknown[] = [];
    const pageByAngle: Record<string, { url: string; text: string } | null> = {
      venue_site: { url: VENUE_PAGE, text: VENUE_TEXT },
      municipal: null,
      registration: { url: TOWN_PAGE, text: TOWN_TEXT },
    };
    return {
      merged,
      researcher: {
        async research(_query, angle) {
          if (options.legsFail) {
            return {
              angle,
              status: 'failed',
              searchResults: 0,
              pagesRead: 0,
              pagesStale: 0,
              pagesRefused: 0,
              pages: [],
              notes: '',
              pagesTruncated: 0,
              reason: 'research_failed: Request timed out.',
            };
          }
          const page = pageByAngle[angle] ?? null;
          if (!page) {
            // The municipal leg reached the web and every fetch was refused — the shape
            // the live probe shows is common, and the one the lane must not read as a
            // page that carries nothing.
            return {
              angle,
              status: 'unread',
              searchResults: 3,
              pagesRead: 0,
              pagesStale: 0,
              pagesRefused: 2,
              pages: [],
              notes: '',
              pagesTruncated: 0,
              reason: null,
            };
          }
          return {
            angle,
            status: 'read',
            searchResults: 4,
            pagesRead: 1,
            pagesStale: 0,
            pagesRefused: 0,
            pages: [page],
            notes: `--- page: ${page.url} ---\n${page.text}`,
            pagesTruncated: 0,
            reason: null,
          };
        },
      },
      synthesiser: {
        async merge(_query, fanOut) {
          merged.push(fanOut.legs.map((leg) => ({ angle: leg.angle, status: leg.status })));
          return {
            status: 'synthesised',
            rows: [
              {
                name: 'Tiny Gym, Cartwheels Gym Centre',
                age_fit: 'walking to 3.5 years',
                // Merged ACROSS TWO LEGS: the grid line is the venue's, the fee line is
                // the venue's fee table, and the registration date is the town's portal.
                when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
                when_quote: 'Tiny Gym | Sun | 9:30-10:15 AM',
                price: '$124 for the 10-week term',
                // The poisoned run attributes a figure that is on NO page it read.
                price_quote: options.poison ? '$310.00 per term' : 'Tiny Gym (10 wks) .......... $124.00',
                registration: 'Registration opened July 22',
                registration_quote: 'Fall registration opens Tuesday, July 22 at 7:00 a.m.',
                // The one fact that lives on ANOTHER leg's page. Naming its source is
                // what lets the refutation check it where it actually is.
                registration_source: TOWN_PAGE,
                source_name: 'Cartwheels Gym Centre',
                source_url: VENUE_PAGE,
              },
            ],
          };
        },
      },
    };
  }

  // ── the coach, with real tools and a scripted set of calls ─────────────────

  function scriptedRunAgent(
    steps: Array<{ tool: string; input: unknown }>,
    write: (results: unknown[]) => string,
  ) {
    return async (args: RunAgentArgs): Promise<RunAgentResult> => {
      const results: unknown[] = [];
      for (const step of steps) {
        const tool = args.tools.find((t) => t.name === step.tool);
        if (!tool) throw new Error(`journey: the runtime registered no tool named ${step.tool}`);
        results.push(await invokeTool(tool, step.input, args.toolContext, args.guardDeps));
      }
      return {
        answer: write(results),
        steps: steps.length + 1,
        hitMaxSteps: false,
        truncatedRetries: 0,
        usage: {
          promptTokens: 100,
          completionTokens: 40,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      };
    };
  }

  function coachFor(
    steps: Array<{ tool: string; input: unknown }>,
    write: (results: unknown[]) => string,
    client: () => AgentClient,
  ) {
    return channelCoachRuntime({
      loadSkill: async () => ({
        name: 'coach-channel-sms',
        instructions: 'journey',
        meta: {
          name: 'coach-channel-sms',
          whenToUse: 'journey',
          task: 'converse' as const,
          tools: [],
        },
      }),
      loadRegistrationWindows: async () => [],
      loadTranscript: async () => [],
      loadContext: async (input) => ({
        parentName: null,
        location: { city: null, province: 'ON', country: 'CA' },
        planTier: 'free' as const,
        children: [],
        focusedChild: null,
        stages: ['toddler' as const],
        memoryFacts: [],
        recentEpisodes: [],
        transcript: [],
        transcriptSummary: null,
        question: input.question,
        intent: null,
        sourceNote: null,
      }),
      loadChildren: async () => [{ name: 'Noah', gender: 'male', dateOfBirth: CHILD_DOB }],
      buildTools: (turn, onDraft, onOffer, onShare, onPromise) =>
        buildChannelCoachTools({
          familyId: turn.familyId,
          reader: {} as never,
          draftPort: {} as never,
          villageTool: searchVillageTool(database),
          activity: {
            reader: bindActivityReader(database, productionActivityFamilyReader()),
            finder: createActivityFinder(client),
          },
          onDraft,
          onOffer,
          onShare,
          onPromise,
          now: turn.now,
        }),
      guardDeps: {
        async writeAudit(entry) {
          await database.insert(schema.auditLog).values({
            familyId: entry.familyId,
            actor: entry.actor,
            actionTaken: entry.actionTaken,
            after: entry.after,
          });
        },
        async checkChildContentAccess() {
          return { ok: true, reason: 'not a teenager' };
        },
      },
      client,
      runAgent: scriptedRunAgent(steps, write),
      recordRun: async () => {},
      now: () => new Date(),
    });
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  const openGate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => TZ,
  };

  const resolver: ReplyResolver = {
    read: async ({ questions }) =>
      toReading({ target: 'ambiguous', polarity: 'yes', confidence: 'high' }, questions),
  };

  function routerDeps(
    transport: FakeTransport,
    coach: ReturnType<typeof coachFor>,
    enqueued: DeepResearchPayload[],
    dispatchFails = false,
  ): ChannelRouterDeps {
    return {
      ...channelRouterDeps(database),
      transport,
      coach,
      replyResolver: resolver,
      offDomain: { consider: async () => ({ status: 'in_domain' as const, fallback: null }) },
      limiter: new FakeRateLimiter(),
      dispatchDeepResearch: async (payload) => {
        if (dispatchFails) {
          return { status: 'not_enqueued' as const, reason: 'queue_unavailable' as const };
        }
        enqueued.push(payload);
        return { status: 'enqueued' as const };
      },
      now: () => TURN_AT,
      log: { info: () => {}, error: () => {} },
    };
  }

  /** The job's dependencies: the REAL delivery over real Postgres, with the transport,
   * the web and the composer's recording as the only ports. */
  function jobDeps(
    transport: FakeTransport,
    lane: DeepLaneDeps,
    overrides: Partial<DeepJobDeps> = {},
    recorded: RecordedModel = recordedModel(RECORDINGS, pipelineClient),
  ): DeepJobDeps {
    const composer = createFollowUpComposer(recorded.client);
    return {
      loadOpen: async (db2, id) => {
        const { loadOpenCommitmentById } = await import('~/lib/commitments/ledger');
        return loadOpenCommitmentById(db2, id);
      },
      resolveRecipient: async (db2, channelMessageId) => {
        const { resolveFollowUpRecipient } = await import('~/lib/channel/activity/sweep');
        return resolveFollowUpRecipient(db2, channelMessageId);
      },
      reader: productionActivityFamilyReader(),
      buildGate: () => openGate,
      dedupeActive,
      lane,
      delivery: {
        composer,
        sharePage: (db2, input) =>
          mintActivitySharePage(db2, input, defaultActivitySharePorts()),
        refuseUnbackedSend,
        resolveSendablePhone: async () => PHONE,
        transport,
        recordSend: async (db2, write) => {
          const [row] = await db2
            .insert(schema.channelMessages)
            .values({
              familyId: write.familyId,
              parentUserId: write.parentUserId,
              channel: 'sms',
              direction: 'out',
              category: 'activity_followup',
              templateKey: write.templateKey,
              dedupeKey: write.dedupeKey,
              providerMessageId: write.providerMessageId,
              status: acceptedStatus('sms'),
              relatedConversationId: write.relatedConversationId,
              sentAt: write.sentAt,
            })
            .returning({ id: schema.channelMessages.id });
          if (!row) throw new Error('journey: channel_messages insert returned no row');
          return row.id;
        },
        audit: async (db2, row) => {
          await db2.insert(schema.auditLog).values(row as never);
        },
        threadMessage: threadProactiveMessage,
        fulfillCommitment,
        recordWatch: async () => ({ status: 'recorded', commitmentId: 'watch-1' }),
      },
      cancelPromise: cancelActivityPromise,
      ...overrides,
    };
  }

  async function inboundText(body: string, at: Date): Promise<string> {
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: 'SM-in-1',
        status: 'delivered',
        body,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    return (row as { id: string }).id;
  }

  async function askAboutTheGym(
    transport: FakeTransport,
    enqueued: DeepResearchPayload[],
    dispatchFails = false,
  ): Promise<void> {
    const coach = coachFor(
      [
        {
          tool: 'find_activities',
          input: { subject: 'Cartwheels Gym Centre fall schedule', window: 'this fall' },
        },
      ],
      (results) => {
        const found = results[0] as { picks: Array<{ name: string }> };
        return `${found.picks[0]?.name} runs a fall block - their site says. I'll read their schedule properly and text you.`;
      },
      inlineWeb(),
    );
    await routeChannelMessage(routerDeps(transport, coach, enqueued, dispatchFails), {
      family_id: familyId,
      parent_user_id: parentUserId,
      channel_message_id: await inboundText(
        'when does the fall term start at cartwheels gym',
        TURN_AT,
      ),
      provider_message_id: 'SM-in-1',
      received_at: TURN_AT.toISOString(),
    });
  }

  async function promiseRows() {
    return database
      .select({
        id: schema.agentCommitments.id,
        topic: schema.agentCommitments.topic,
        fulfilledAt: schema.agentCommitments.fulfilledAt,
        cancelledAt: schema.agentCommitments.cancelledAt,
        createdFrom: schema.agentCommitments.createdFrom,
      })
      .from(schema.agentCommitments)
      .where(
        and(
          eq(schema.agentCommitments.familyId, familyId),
          eq(schema.agentCommitments.commitmentKind, 'activity_followup'),
        ),
      );
  }

  async function threadBodies(): Promise<string[]> {
    const rows = await database
      .select({ body: schema.messages.content, role: schema.messages.role })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
      .where(eq(schema.conversations.familyId, familyId));
    return rows.filter((row) => row.role === 'assistant').map((row) => row.body);
  }

  // ── MESSAGE ONE ────────────────────────────────────────────────────────────

  it('MESSAGE ONE - answers inline, writes the promise down, and queues the deep pass against it', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];

    await askAboutTheGym(transport, enqueued);

    // The parent has an answer NOW, with the coming-back sentence in it.
    expect(transport.bodies()[0]).toContain('Cartwheels');
    expect(transport.bodies()[0]).toMatch(/I'll read their schedule/);

    // The promise is a row, minted against the outbound message that carried it.
    const [promise] = await promiseRows();
    expect(promise?.topic).toBe('Cartwheels Gym Centre fall schedule');
    expect(promise?.fulfilledAt).toBeNull();

    // ...and the deep pass is queued against THAT row.
    expect(enqueued).toEqual([{ commitment_id: promise?.id, family_id: familyId }]);
  });

  // ── MESSAGE TWO ────────────────────────────────────────────────────────────

  it('MESSAGE TWO - the job merges the legs, survives the refutation, and closes the promise', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];
    await askAboutTheGym(transport, enqueued);
    const payload = enqueued[0];
    if (!payload) throw new Error('journey: nothing was enqueued');

    const lane = deepLane();
    const composed = recordedModel(RECORDINGS, pipelineClient);
    const outcome = await runDeepResearchJob(
      database,
      payload,
      jobDeps(transport, lane, {}, composed),
      JOB_AT,
    );

    expect(outcome.status).toBe('sent');

    // TWO messages, in order, on one question.
    expect(transport.sent).toHaveLength(2);
    const second = transport.bodies()[1] ?? '';
    // The fee, off the venue's own fee table - a fact the inline turn did not have.
    expect(second).toContain('124');
    // AND THE REGISTRATION DATE REACHED THE COMPOSER. Asserted on the PROJECTION rather
    // than on the model's wording: what the composer chooses to say is the eval's
    // question (rule #8), and what this journey owns is that the fact merged across two
    // legs, survived the refutation, and was actually put in front of it. That is exactly
    // where it was lost in production - the projection did not carry the field.
    expect(composed.requests.join('\n')).toContain('July 22');

    // The merge was told what each angle did, including the one that opened nothing.
    expect(lane.merged[0]).toEqual([
      { angle: 'venue_site', status: 'read' },
      { angle: 'municipal', status: 'unread' },
      { angle: 'registration', status: 'read' },
    ]);

    // It landed in the parent's own thread (#531), so their reply reads as an ordinary
    // coach turn with the finds above it.
    const thread = await threadBodies();
    expect(thread.some((body) => body.includes('124'))).toBe(true);

    // And the promise is KEPT, against the message that kept it.
    const [promise] = await promiseRows();
    expect(promise?.fulfilledAt).not.toBeNull();
  });

  it('MESSAGE TWO - drops the fact the merge could not quote, and still sends the rest', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];
    await askAboutTheGym(transport, enqueued);
    const payload = enqueued[0];
    if (!payload) throw new Error('journey: nothing was enqueued');

    // The merge attributes a $310 fee that is on no page any leg opened.
    const outcome = await runDeepResearchJob(
      database,
      payload,
      jobDeps(transport, deepLane({ poison: true })),
      JOB_AT,
    );

    expect(outcome.status).toBe('sent');
    const second = transport.bodies()[1] ?? '';
    // The unquotable figure never reaches the wire...
    expect(second).not.toContain('310');
    // ...and the two facts that WERE quoted still do. A refuted fact is an absence, not
    // a silenced message.
    expect(second).toMatch(/July 22|registration/i);

    // The refusal is on the audit row, so a lane quietly dropping facts is visible.
    const [audit] = await database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'activity_followup_sent'),
        ),
      );
    expect(audit?.after).toMatchObject({ factsRefused: 1 });
  });

  // ── THE FALLBACK ───────────────────────────────────────────────────────────

  /**
   * THE PROPERTY THE WHOLE LANE RESTS ON. The deep pass is an optimisation; when it
   * cannot run, the parent must be exactly as well off as they were before it existed.
   */
  it('THE FALLBACK - a dead deep pass sends nothing and leaves the promise for the sweep', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];
    await askAboutTheGym(transport, enqueued);
    const payload = enqueued[0];
    if (!payload) throw new Error('journey: nothing was enqueued');

    const outcome = await runDeepResearchJob(
      database,
      payload,
      jobDeps(transport, deepLane({ legsFail: true })),
      JOB_AT,
    );

    expect(outcome).toEqual({ status: 'left_open', reason: 'deep_unavailable' });
    // No second message, and no half-answer.
    expect(transport.sent).toHaveLength(1);
    // The debt is untouched: still open, still due, still selected by the hourly sweep.
    const [promise] = await promiseRows();
    expect(promise?.fulfilledAt).toBeNull();
    expect(promise?.cancelledAt).toBeNull();
  });

  it('THE FALLBACK - a queue that never took the job still leaves a promise the sweep can keep', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];

    await askAboutTheGym(transport, enqueued, true);

    expect(enqueued).toEqual([]);
    const [promise] = await promiseRows();
    expect(promise?.topic).toBe('Cartwheels Gym Centre fall schedule');
    expect(promise?.fulfilledAt).toBeNull();
  });

  it('a redelivered job after the send drops rather than texting twice', async () => {
    const transport = new FakeTransport();
    const enqueued: DeepResearchPayload[] = [];
    await askAboutTheGym(transport, enqueued);
    const payload = enqueued[0];
    if (!payload) throw new Error('journey: nothing was enqueued');

    await runDeepResearchJob(database, payload, jobDeps(transport, deepLane()), JOB_AT);
    const again = await runDeepResearchJob(database, payload, jobDeps(transport, deepLane()), JOB_AT);

    expect(again).toEqual({ status: 'dropped', reason: 'not_open' });
    expect(transport.sent).toHaveLength(2);
  });
});
