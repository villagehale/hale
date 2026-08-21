import type { AgentClient, RunAgentArgs, RunAgentResult } from '@hale/agent';
import { invokeTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import {
  type ActivityFollowUpDeps,
  defaultActivityFollowUpDeps,
  runActivityFollowUpSweep,
} from '~/lib/channel/activity/sweep';
import { channelCoachRuntime } from '~/lib/channel/coach/runtime';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { conflictReply } from '~/lib/channel/router/copy';
import type { ChannelRouterDeps } from '~/lib/channel/router/route';
import { routeChannelMessage } from '~/lib/channel/router/route';
import { type ReplyResolver, toReading } from '~/lib/channel/router/resolve';
import {
  channelRouterDeps,
  defaultApprovalSpine,
  defaultOpenQuestionReader,
} from '~/lib/channel/router/wiring';
import { type ApproveQueue, approveDraftedAction } from '~/lib/actions/approve';
import { approvalHandler } from '~/lib/channel/router/handlers';
import { searchVillageTool } from '~/lib/coach/tools';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * "I'LL COME BACK TO YOU ON IT" — the 2026-08-20 18:13-18:19 UTC transcript, replayed.
 *
 * WHAT HAPPENED. A parent asked what their toddler could do from September to December.
 * The coach had one activity verb, `search_village`, which reads finds the radar has
 * already discovered — and three filters emptied it (a season gate that hides FALL
 * programs from a question asked in SUMMER, a substring match over the whole query, and
 * an offerability rule no row in production satisfies). Hale named nothing and said it
 * would come back. Three minutes later the parent named a specific gym; Hale called no
 * tool at all and offered "want me to do a search?" — a verb that did not exist. They said
 * "Yes, please", and because the ONLY thing Hale was holding was a thirteen-hour-old
 * calendar draft its own reviewer had flagged, the bare affirmative was claimed by the
 * approvals grammar and answered with a line about that draft. Three turns, three
 * failures, and not one row written down.
 *
 * WHAT THIS PINS, through the REAL pipeline over real Postgres:
 *
 *   TURN 1 yields concrete picks. The real coach runtime, the real tool registration, the
 *   real de-identification, the real lane. Only the WEB is a port — the search results are
 *   a fixture, because a journey test may not depend on what a gym publishes today.
 *
 *   TURN 2 (the named place) fetches and answers, instead of offering a verb Hale does not
 *   have — and the "I'll check the fall spots" it ends on is WRITTEN DOWN as it is said.
 *
 *   TURN 3's bare "Yes, please" is no longer unambiguous, BECAUSE of that row. Two kinds
 *   of question are standing, so the approvals grammar declines the word and the turn
 *   reaches the coach — which is the structural end of the hijack. The coach sharpens the
 *   promise, superseding the first row, and the SWEEP keeps it a day later.
 *
 * THE ORDER IS THE POINT. The promise has to be a row BEFORE the affirmative arrives, not
 * after it, which is why registering at SEND time rather than at reply time is the whole
 * design and not a detail.
 *
 * WHAT IS FAKED, and only this: the SMS transport, the WEB, and the model's WORDS. The
 * tool CALLS are real invocations through the guarded invoker (rule #6 audit rows and all);
 * what the model chooses to say is the eval's job (rule #8 — apps/worker/evals/
 * run-activity-finder-eval.mjs).
 *
 * The mutation at the bottom is the point of the whole file: delete the send-time promise
 * registration and turn 3 is a sentence nobody is holding — the sweep selects nobody, and
 * the parent's next bare "yes" lands back on the flagged calendar draft.
 */

const TZ = 'America/Toronto';
/** Georgetown, Halton Hills — the incident family's real FSA. */
const AREA = 'L7G';
const PHONE = '+14165550100';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

const TURN_1_AT = new Date('2026-08-20T18:14:44.000Z');
const TURN_2_AT = new Date('2026-08-20T18:17:52.000Z');
const TURN_3_AT = new Date('2026-08-20T18:18:05.000Z');
/** The next hourly nudge tick after the promise came due (24h later). */
const SWEEP_AT = new Date('2026-08-21T19:00:00.000Z');

/** 18 months at the incident — a toddler, the beachhead stage. */
const CHILD_DOB = '2025-02-20';

const GYM_RESULT = {
  name: 'Parent & Tot Gymnastics, Halton Hills Gymnastics Centre',
  age_fit: '18 months - 3 years',
  when: 'Saturdays 9:15am, fall session from Sept 13',
  price: '$142 for 12 weeks',
  source_name: 'Halton Hills Gymnastics Centre',
};
const EARLYON_RESULT = {
  name: 'EarlyON drop-in, Georgetown (Links2Care)',
  age_fit: 'ages 0-6',
  when: 'Weekday mornings, fall schedule from Sept 8',
  price: 'free',
  source_name: 'Links2Care',
};

describe('the activity question is answered', () => {
  let db: TestDb;
  let database: Database;
  let familyId: string;
  let parentUserId: string;
  let childId: string;
  let flaggedActionId: string;

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

    const [child] = await database
      .insert(schema.children)
      .values({ familyId, name: 'Noah', dateOfBirth: CHILD_DOB })
      .returning({ id: schema.children.id });
    childId = (child as { id: string }).id;

    // THE HIJACKER, exactly as production held it: a calendar_add drafted from the voice
    // session thirteen hours earlier, flagged by Hale's own reviewer, never swept.
    const [event] = await database
      .insert(schema.events)
      .values({
        familyId,
        source: 'channel_sms',
        eventType: 'channel_sms.calendar_intent',
        dedupHash: 'journey-swim-lessons',
      })
      .returning({ id: schema.events.id });
    const [action] = await database
      .insert(schema.actions)
      .values({
        familyId,
        eventId: (event as { id: string }).id,
        actionType: 'calendar_add',
        payload: { title: 'Swim lessons', date: '2026-08-22' },
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: 'flagged',
        draftedAt: new Date('2026-08-20T05:07:00.000Z'),
      })
      .returning({ id: schema.actions.id });
    flaggedActionId = (action as { id: string }).id;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  // ── the web, as a port ─────────────────────────────────────────────────────

  /**
   * The Anthropic client the LANE drives: a real grounded turn shape (a
   * `web_search_tool_result` with real result items, which is what the lane's grounding
   * invariant counts) followed by a real forced-tool extraction. Only the CONTENT is a
   * fixture — everything the lane does with it is production code.
   */
  function webPort(picksByCall: Array<Array<Record<string, unknown>>>): {
    client: () => AgentClient;
    searched: string[];
  } {
    const searched: string[] = [];
    let call = -1;
    const client = () =>
      ({
        messages: {
          // biome-ignore lint/suspicious/noExplicitAny: a fixture standing in for the web
          async create(req: any) {
            if (req.tool_choice?.name === 'activity_picks') {
              return {
                content: [
                  { type: 'tool_use', name: 'activity_picks', input: { picks: picksByCall[call] ?? [] } },
                ],
                usage: { input_tokens: 10, output_tokens: 10 },
                stop_reason: 'tool_use',
              };
            }
            call += 1;
            searched.push(req.messages?.[0]?.content as string);
            return {
              content: [
                { type: 'text', text: 'Read the fall schedule and registration pages.' },
                {
                  type: 'web_search_tool_result',
                  tool_use_id: `srvtu_${call}`,
                  content: [
                    {
                      type: 'web_search_result',
                      url: 'https://venue.example/fall',
                      title: 'Fall programs',
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

  // ── the coach, with real tools and a scripted set of calls ─────────────────

  /**
   * A `runAgent` stand-in that DISPATCHES REAL TOOLS.
   *
   * It is not a fake coach. It takes the tool set the production runtime built, invokes
   * the named tools through the real guarded invoker (`invokeTool` — audit rows, teen
   * gate, spend check), and hands the results to a writer that composes the answer. What
   * is scripted is only the model's CHOICE of tool and its wording; everything the tools
   * then do — de-identify, search, stamp the source, register the promise — is production
   * code, which is the whole point of running the transcript through here.
   */
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
      // The context assembly is the app coach's own, tested where it lives; what this
      // journey is about is the verbs, so it is the minimum shape the runtime reads.
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
          // The REAL reader over the REAL rows, and the REAL lane over the web port.
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

  // ── plumbing shared with the other journeys ────────────────────────────────

  /**
   * The approvals spine, with the pg-boss handle swapped for a fake.
   *
   * `approveDraftedAction` runs every real precondition — the family scope, the state, and
   * the reviewer gate that refuses this flagged draft — and only enqueues AFTER they pass,
   * so nothing about the refusal below is faked. What is faked is the queue the production
   * wiring opens eagerly, one line before the call.
   */
  function spineWithFakeQueue() {
    const queue: ApproveQueue = { send: async () => 'job-1' };
    return {
      ...defaultApprovalSpine(),
      approve: async (
        db: Database,
        args: { actionId: string; familyId: string; approvedBy: string },
      ) => {
        const result = await approveDraftedAction(db, queue, args);
        return result.status === 202
          ? ({ ok: true } as const)
          : ({ ok: false, reason: 'not_reviewer_approved' } as const);
      },
    };
  }

  const openGate: OutboundGatePorts = {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => TZ,
  };

  function recordedResolver(raw: {
    target: string;
    polarity: string;
    confidence: string;
  }): ReplyResolver {
    return { read: async ({ questions }) => toReading(raw, questions) };
  }

  function routerDeps(
    transport: FakeTransport,
    coach: ReturnType<typeof coachFor>,
    now: Date,
    overrides: Partial<ChannelRouterDeps> = {},
  ): ChannelRouterDeps {
    return {
      ...channelRouterDeps(database),
      transport,
      coach,
      replyResolver: recordedResolver({
        target: 'ambiguous',
        polarity: 'yes',
        confidence: 'high',
      }),
      // Every message below is plainly about this family's own week; the off-domain screen
      // is a model call this journey never needs to make.
      offDomain: { consider: async () => ({ status: 'in_domain' as const, fallback: null }) },
      limiter: new FakeRateLimiter(),
      now: () => now,
      log: { info: () => {}, error: () => {} },
      ...overrides,
    };
  }

  async function inboundText(body: string, at: Date, n: number): Promise<string> {
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: `SM-in-${n}`,
        status: 'delivered',
        body,
        sentAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    return (row as { id: string }).id;
  }

  async function route(
    body: string,
    at: Date,
    n: number,
    deps: ChannelRouterDeps,
  ): Promise<void> {
    await routeChannelMessage(deps, {
      family_id: familyId,
      parent_user_id: parentUserId,
      channel_message_id: await inboundText(body, at, n),
      provider_message_id: `SM-in-${n}`,
      received_at: at.toISOString(),
    });
  }

  const openQuestions = (now: Date) =>
    defaultOpenQuestionReader().open(database, { familyId, parentUserId, now });

  async function promiseRows() {
    return database
      .select({
        id: schema.agentCommitments.id,
        topic: schema.agentCommitments.topic,
        summary: schema.agentCommitments.summary,
        subjectChildId: schema.agentCommitments.subjectChildId,
        dueAt: schema.agentCommitments.dueAt,
        fulfilledAt: schema.agentCommitments.fulfilledAt,
        cancelledAt: schema.agentCommitments.cancelledAt,
        cancelledReason: schema.agentCommitments.cancelledReason,
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

  // ── TURN 1 ─────────────────────────────────────────────────────────────────

  it('TURN 1 - "something to do from September to December" comes back with picks, not a deferral', async () => {
    const web = webPort([[GYM_RESULT, EARLYON_RESULT]]);
    const transport = new FakeTransport();
    const coach = coachFor(
      [
        // The radar read still happens first — it is the verified tier and it is free.
        { tool: 'search_village', input: { query: 'fall' } },
        { tool: 'find_activities', input: { subject: 'toddler gymnastics and drop-ins', window: 'September to December' } },
      ],
      (results) => {
        const found = results[1] as { found: boolean; picks: Array<{ name: string; when: string }> };
        const top = found.picks[0];
        return `${top?.name} has parent & tot ${top?.when}, $142 - their site says. Want me to confirm before you book?`;
      },
      web.client,
    );

    await route(
      'I wanna find something to do for Noah from September to December what is available near me',
      TURN_1_AT,
      1,
      routerDeps(transport, coach, TURN_1_AT),
    );

    const reply = transport.bodies()[0] ?? '';
    // A NAME, a WHEN, and whose facts they are — the thing the incident reply had none of.
    expect(reply).toContain('Halton Hills Gymnastics Centre');
    expect(reply).toContain('Sept 13');
    expect(reply).toContain('their site says');
    expect(reply).not.toMatch(/come back to you/i);

    // Rule #1, at the border: the query that left carried a TOWN and a BAND and no child.
    const sent = web.searched[0] ?? '';
    expect(JSON.parse(sent)).toMatchObject({ town: 'Halton Hills', stage: 'toddler' });
    expect(sent).not.toContain('Noah');
    expect(sent).not.toContain('L7G');
    expect(sent).not.toMatch(/\b18 months\b/);

    // Rule #6: the tool call is on the audit log, which is the ledger the incident was
    // diagnosed from — absence of a row is what proved the tool never ran.
    const audit = await database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit.map((row) => row.actionTaken)).toContain('tool:find_activities');
  });

  // ── TURN 2 ─────────────────────────────────────────────────────────────────

  it('TURN 2 - a named place is fetched and answered, not offered a verb Hale does not have', async () => {
    const web = webPort([
      [
        {
          name: 'Cartwheel Gym parent & tot',
          age_fit: '12 months - 3 years',
          when: 'Tuesdays 10:00am, fall term from Sept 9',
          price: null,
          source_name: 'Cartwheel Gym',
        },
      ],
    ]);
    const transport = new FakeTransport();
    const coach = coachFor(
      [
        { tool: 'find_activities', input: { subject: 'Cartwheel Gym parent and tot' } },
        {
          tool: 'promise_activity_followup',
          input: { subject: 'Cartwheel Gym fall spots', childId },
        },
      ],
      (results) => {
        const found = results[0] as { picks: Array<{ name: string; when: string }> };
        const top = found.picks[0];
        return `${top?.name} runs ${top?.when} - their site says. I'll check the fall spots tomorrow and text you.`;
      },
      web.client,
    );

    await route(
      'Wha about cartwheel gym did you find anything there',
      TURN_2_AT,
      2,
      routerDeps(transport, coach, TURN_2_AT),
    );

    const reply = transport.bodies()[0] ?? '';
    expect(reply).toContain('Cartwheel Gym');
    expect(reply).toContain('Sept 9');
    // The incident's actual reply. There is no `do_a_search` verb and there never was —
    // now there is a real one, so the offer is not the answer.
    expect(reply).not.toMatch(/want me to do a search/i);
    expect(web.searched).toHaveLength(1);
    // A missing price is not a reason to withhold the find (rule: never go quiet).
    expect(reply).not.toMatch(/couldn't confirm|can't confirm|unable to/i);

    // AND THE COMING-BACK SENTENCE IS A ROW. This is the sentence the incident ended on
    // with nothing behind it.
    expect(await promiseRows()).toMatchObject([
      { topic: 'Cartwheel Gym fall spots', subjectChildId: childId, fulfilledAt: null },
    ]);
  });

  // ── TURN 3 + THE SWEEP ─────────────────────────────────────────────────────

  /**
   * Turn 2, replayed as the SETUP for turn 3: the answer plus the promise, written down.
   * Returns the id of the standing question that row became.
   */
  async function turnTwoPromises(overrides: Partial<ChannelRouterDeps> = {}): Promise<void> {
    const web = webPort([
      [
        {
          name: 'Cartwheel Gym parent & tot',
          age_fit: '12 months - 3 years',
          when: 'Tuesdays 10:00am, fall term from Sept 9',
          price: null,
          source_name: 'Cartwheel Gym',
        },
      ],
    ]);
    const coach = coachFor(
      [
        { tool: 'find_activities', input: { subject: 'Cartwheel Gym parent and tot' } },
        {
          tool: 'promise_activity_followup',
          input: { subject: 'Cartwheel Gym fall spots', childId },
        },
      ],
      () =>
        "Cartwheel Gym parent & tot runs Tuesdays 10:00am, fall term from Sept 9 - their site says. I'll check the fall spots tomorrow and text you.",
      web.client,
    );
    await route(
      'Wha about cartwheel gym did you find anything there',
      TURN_2_AT,
      2,
      routerDeps(new FakeTransport(), coach, TURN_2_AT, overrides),
    );
  }

  it('TURN 3 - the bare "Yes, please" reaches the coach, and the sweep keeps the promise', async () => {
    await turnTwoPromises();

    // TWO kinds standing: the thirteen-hour-old flagged draft, and the promise Hale just
    // made. That is what makes the affirmative ambiguous — and ambiguity is what stops
    // the approvals grammar claiming it (`soleOpenKind`).
    const standing = await openQuestions(TURN_3_AT);
    expect(standing.map((q) => q.kind).sort()).toEqual(['activity_followup', 'approval']);
    const promiseQuestion = standing.find((q) => q.kind === 'activity_followup');
    // A promise is not a question: neither polarity has anywhere to go, so the resolver
    // hands the turn on rather than binding an acceptance to a row nothing would act on.
    expect(promiseQuestion?.answerable).toEqual({ yes: false, no: false });

    const transport = new FakeTransport();
    const web = webPort([[GYM_RESULT]]);
    const coach = coachFor(
      [
        {
          tool: 'promise_activity_followup',
          input: { subject: 'Cartwheel Gym fall spots and other toddler fall programs', childId },
        },
      ],
      () => "On it - I'll go through the fall listings tomorrow and text you what has opened.",
      web.client,
    );

    await route(
      'Yes, please',
      TURN_3_AT,
      3,
      routerDeps(transport, coach, TURN_3_AT, {
        // What the resolver really reads here: the words name the promise, and the promise
        // takes no answer — so `toReading` returns `not_answerable` and the coach owns it.
        replyResolver: recordedResolver({
          target: promiseQuestion?.id as string,
          polarity: 'yes',
          confidence: 'high',
        }),
      }),
    );

    // THE INCIDENT'S REPLY, and it is gone. No line about a draft the parent never
    // mentioned, no reviewer jargon at all.
    const reply = transport.bodies()[0] ?? '';
    expect(reply).not.toBe(conflictReply('not_reviewer_approved'));
    expect(reply).not.toMatch(/double-checking|cleared my own checks|reviewer|flagged/i);
    expect(reply).toMatch(/fall listings/);

    // ONE open promise, superseded to the sharper subject — the ledger's partial unique
    // index is what makes that the only way to promise twice.
    const rows = await promiseRows();
    expect(rows).toHaveLength(2);
    const stillOpen = rows.filter((row) => row.fulfilledAt === null && row.cancelledAt === null);
    expect(stillOpen).toHaveLength(1);
    // The first promise was VOIDED with a reason rather than deleted — the ledger keeps
    // what Hale said even when a newer sentence replaced it.
    expect(rows.find((row) => row.cancelledAt !== null)?.cancelledReason).toBe(
      'activity_promise_superseded',
    );
    const [open] = stillOpen;
    expect(open?.topic).toBe('Cartwheel Gym fall spots and other toddler fall programs');
    expect(open?.dueAt.getTime()).toBe(TURN_3_AT.getTime() + 24 * 3_600_000);
    const [carrier] = await database
      .select({ direction: schema.channelMessages.direction })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, open?.createdFrom as string));
    expect(carrier?.direction).toBe('out');

    // THE SWEEP, a day later. It re-runs the search on the STORED subject and comes back.
    const sweepWeb = webPort([[GYM_RESULT]]);
    const sweepTransport = new FakeTransport();
    const result = await runActivityFollowUpSweep(
      database,
      sweepDeps(sweepTransport, sweepWeb.client),
      SWEEP_AT,
    );

    expect(result).toMatchObject({ due: 1, sent: 1, sentEmptyHanded: 0 });
    expect(sweepTransport.bodies()[0]).toContain('Halton Hills Gymnastics Centre');
    expect(JSON.parse(sweepWeb.searched[0] ?? '{}')).toMatchObject({
      subject: 'Cartwheel Gym fall spots and other toddler fall programs',
      town: 'Halton Hills',
    });

    // The debt is discharged, and stops standing.
    const [kept] = (await promiseRows()).filter((row) => row.fulfilledAt !== null);
    expect(kept?.topic).toBe('Cartwheel Gym fall spots and other toddler fall programs');
    expect((await openQuestions(SWEEP_AT)).some((q) => q.kind === 'activity_followup')).toBe(false);
  });

  it('the promise is kept even when the second look finds nothing', async () => {
    await turnTwoPromises();

    const sweepTransport = new FakeTransport();
    const result = await runActivityFollowUpSweep(
      database,
      sweepDeps(sweepTransport, webPort([[]]).client),
      SWEEP_AT,
    );

    // Coming back empty-handed and SAYING SO is keeping the promise. A sweep that only
    // texted on success would leave this family waiting forever for the answer to a
    // question Hale had quietly given up on.
    expect(result).toMatchObject({ sent: 1, sentEmptyHanded: 1 });
    expect(sweepTransport.bodies()[0]).toMatch(/nothing has opened yet/);
    expect((await promiseRows())[0]?.fulfilledAt).not.toBeNull();
  });

  // ── THE MUTATION ───────────────────────────────────────────────────────────

  it('MUTATION - with the send-time promise write removed, the incident happens again', async () => {
    // The ONE thing removed: the router's post-send registration. Everything else is
    // untouched — the coach still searches, still answers, still composes a perfect
    // coming-back sentence, and the parent still reads it.
    await turnTwoPromises({
      recordActivityPromise: async () => ({ status: 'not_recorded', reason: 'write_failed' }),
    });

    expect(await promiseRows()).toHaveLength(0);

    // Nothing is standing but the thirteen-hour-old flagged draft — production's exact
    // state at 18:18:05.
    const standing = await openQuestions(TURN_3_AT);
    expect(standing.map((q) => q.kind)).toEqual(['approval']);
    expect(standing[0]?.id).toBe(flaggedActionId);

    // ...so the bare affirmative is claimed by the approvals grammar and answered with a
    // line about a draft the parent never mentioned. This is the message that was
    // actually sent on 2026-08-20.
    const transport = new FakeTransport();
    const base = channelRouterDeps(database);
    await route(
      'Yes, please',
      TURN_3_AT,
      3,
      routerDeps(transport, coachFor([], () => 'never reached', webPort([[]]).client), TURN_3_AT, {
        handlers: base.handlers.map((handler) =>
          handler.name === 'approval' ? approvalHandler(spineWithFakeQueue()) : handler,
        ),
      }),
    );
    expect(transport.bodies()[0]).toBe(conflictReply('not_reviewer_approved'));

    // And no sweep can ever select them.
    const result = await runActivityFollowUpSweep(
      database,
      sweepDeps(new FakeTransport(), webPort([[GYM_RESULT]]).client),
      SWEEP_AT,
    );
    expect(result).toMatchObject({ due: 0, sent: 0 });
  });

  /** The sweep, wired to the real ledger and the real composer gates, with the web and the
   * wire as ports and the composer's WORDS scripted (rule #8 — its judgement is the
   * eval's). */
  function sweepDeps(transport: FakeTransport, client: () => AgentClient): ActivityFollowUpDeps {
    return {
      ...defaultActivityFollowUpDeps(),
      finder: createActivityFinder(client),
      composer: {
        async compose({ picks }) {
          const top = picks[0];
          return {
            status: 'composed',
            message: top
              ? `${top.name} runs ${top.when} - their site says. Want me to confirm?`
              : 'I went back through the fall listings and nothing has opened yet. Want me to keep watching?',
          };
        },
      },
      buildGate: () => openGate,
      resolveSendablePhone: async () => PHONE,
      transport,
    };
  }
});
