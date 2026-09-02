import { type RegisteredTool, type Skill, invokeTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFindResult, ActivityFinder } from '~/lib/channel/activity/lane';
import { bindActivityReader, productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { buildChannelCoachTools } from '~/lib/channel/coach/tools';
import type { AgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type RelaySocket, createRelaySession } from './relay-session';
import { mintRelayToken } from './relay-token';
import { withVoiceLookupBudget } from './voice-lookup';
import { defaultVoicePromisePorts, voicePromiseRecorder } from './voice-promise';
import { voiceCallRecorder } from './voice-record';
import { voiceTurnStream } from './voice-turn';

/**
 * VIL-313 · "CAN YOU SEARCH FOR ME" — the two halves of this ticket, composed.
 *
 * Founder call CA170c1fb0: the parent asked out loud for a search and got "nothing
 * verified in my list" — a read of an empty table, because the call had no verb that
 * reached the web. Two things had to be true for that to stop being the answer, and
 * neither is worth much alone:
 *
 *   THE CALL CAN LOOK, inside a wall a caller can hold a silent line through
 *   (voice-lookup.ts).
 *   WHAT IT CANNOT FINISH IN TIME BECOMES A TEXT, because the fallback sentence is
 *   written down as it is spoken (voice-promise.ts).
 *
 * So the two paths through one seam, end to end over real Postgres: the search that beat
 * the wall answers on the call and owes nothing, and the search that did not promises a
 * text and leaves a row the hourly sweep will pay.
 *
 * REAL: the tool registration, the guarded invoker, phase-0 de-identification, the wall,
 * the claim extractor, the ledger, the recorder, the session, Postgres. FAKED: the web,
 * the clock, and the model's WORDS — what a model chooses to say about each outcome is
 * the skill's job and the eval's (rule #8); what is pinned here is whether the sentence
 * it says becomes a debt.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const CALL_SID = 'CA00000000000000000000000000000314';
const NOW = new Date('2026-08-26T03:11:00.000Z');
const ASKED = 'can you look up toddler gymnastics for the fall';

/** What the model says when the lookup came back in time — the fact, and its source. */
const GROUNDED =
  'Their site says Parent and Tot runs Saturdays at nine fifteen, fall from September thirteenth.';
/** What it says when the wall closed. The skill's shape, and a promise piece 1 records. */
const FALLBACK = "Still digging on that one - I'll text you what I find.";

const PICKS: ActivityFindResult = {
  found: true,
  picks: [
    {
      name: 'Parent & Tot Gymnastics',
      ageFit: '18 months - 3 years',
      when: 'Saturdays 9:15am, fall session from Sept 13',
      price: '$142 for 12 weeks',
      sourceName: 'Halton Hills Gymnastics Centre',
      source: 'web',
    },
  ],
};

const SKILL: Skill = {
  meta: {
    name: 'voice-turn',
    whenToUse: 'a call',
    task: 'speak',
    tools: ['find_activities'],
  },
  instructions: 'speak briefly',
};

function fakeSocket() {
  const sent: string[] = [];
  const socket: RelaySocket = {
    send: (frame) => {
      sent.push(frame);
    },
    close: () => {},
  };
  return {
    socket,
    spoken: () =>
      sent
        .map((frame) => JSON.parse(frame) as { type: string; token?: string })
        .filter((frame) => frame.type === 'text')
        .map((frame) => frame.token ?? '')
        .join(''),
  };
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function openCommitments(database: Database, familyId: string) {
  return database
    .select({ topic: schema.agentCommitments.topic, dueAt: schema.agentCommitments.dueAt })
    .from(schema.agentCommitments)
    .where(eq(schema.agentCommitments.familyId, familyId));
}

/**
 * One spoken turn that reaches for the web verb. `finder` decides whether the wall wins.
 * The model's words are chosen from the tool's OWN result, which is the thing under test:
 * a turn that cannot tell `over_budget` from "there is nothing" cannot say either
 * honestly.
 */
async function callAndAsk(options: {
  familyId: string;
  parentUserId: string;
  finder: ActivityFinder;
  /** Resolves the wall. Never, for the search that wins. */
  wall: (ms: number) => Promise<void>;
}) {
  const ticket = {
    callSid: CALL_SID,
    familyId: options.familyId,
    parentUserId: options.parentUserId,
  };
  const promises = voicePromiseRecorder(
    db.database,
    defaultVoicePromisePorts(bindActivityReader(db.database, productionActivityFamilyReader())),
  );
  const wire = fakeSocket();
  /** What the tool actually handed the model — asserted, so a green spoken line cannot
   * come from a turn that never looked. */
  let toolResult: unknown = null;

  const session = createRelaySession({
    socket: wire.socket,
    token: mintRelayToken(ticket, NOW),
    recorder: voiceCallRecorder(db.database),
    claimCall: async () => true,
    promiseSpoken: (input) => promises.record(input),
    turn: voiceTurnStream({
      loadSkill: async () => SKILL,
      loadTranscript: async () => [],
      loadContext: async () => ({ children: [], transcript: [] }) as unknown as AgentContext,
      answerSpoken: async () => ({ status: 'not_an_answer' }) as const,
      buildTools: (turn, onDraft) =>
        buildChannelCoachTools({
          familyId: turn.familyId,
          reader: {} as never,
          draftPort: {} as never,
          villageTool: null,
          activity: {
            reader: bindActivityReader(db.database, productionActivityFamilyReader()),
            finder: withVoiceLookupBudget(
              options.finder,
              { log: { error: vi.fn() }, wait: options.wall },
            ),
          },
          onPromise: promises.collect,
          onDraft,
          now: turn.now,
        }),
      client: () => ({ messages: {} }) as never,
      // The model, scripted: it reaches for the verb, reads the reason, and says the
      // sentence the skill asks for. Everything it calls THROUGH is real.
      runStreaming: async (args) => {
        const tool = args.tools.find((t: RegisteredTool) => t.name === 'find_activities');
        if (!tool) throw new Error('the call registered no web verb');
        args.onToolCall?.({ name: tool.name } as never);
        toolResult = await invokeTool(
          tool,
          { subject: 'toddler gymnastics', window: 'this fall' },
          args.toolContext,
          args.guardDeps,
        );
        const answer = (toolResult as { found: boolean }).found ? GROUNDED : FALLBACK;
        args.onTextDelta(answer);
        return {
          answer,
          steps: 2,
          hitMaxSteps: false,
          truncatedRetries: 0,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        };
      },
      guardDeps: {
        async writeAudit() {},
        async checkChildContentAccess() {
          return { ok: true, reason: 'ok' };
        },
      },
      recordRun: async () => {},
      log: { error: vi.fn() },
      now: () => NOW,
    }),
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    now: () => NOW,
  });

  await session.handleMessage(
    JSON.stringify({ type: 'setup', sessionId: 'VX1', callSid: CALL_SID }),
  );
  await session.handleMessage(
    JSON.stringify({ type: 'prompt', voicePrompt: ASKED, lang: 'en-US', last: true }),
  );
  return { spoken: wire.spoken(), toolResult: () => toolResult };
}

describe('an explicit spoken search request', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('BUDGET BLOWN: speaks the fallback and leaves a row the sweep will pay', async () => {
    const family = await seedFamily(db.database);
    const call = await callAndAsk({
      ...family,
      // The shape a thirty-second research turn has from inside a six-second wall.
      finder: { find: () => new Promise<ActivityFindResult>(() => {}) },
      wall: async () => {},
    });

    expect(call.toolResult()).toEqual({ found: false, reason: 'over_budget' });
    expect(call.spoken).toContain(FALLBACK);

    const rows = await openCommitments(db.database, family.familyId);
    expect(rows).toHaveLength(1);
    // The subject came from the VERB, de-identified, not from the caller's rambling
    // utterance — so the sweep re-runs the search Hale actually promised.
    expect(rows[0]?.topic).toBe('toddler gymnastics');
    expect(rows[0]?.topic).not.toBe(ASKED);
    // Two hours, so the next hourly nudge tick after it comes due pays it as a real SMS.
    expect(rows[0]?.dueAt).toEqual(new Date(NOW.getTime() + 2 * 3_600_000));
  });

  it('FOUND IN TIME: speaks the fact and owes the parent nothing', async () => {
    const family = await seedFamily(db.database);
    const call = await callAndAsk({
      ...family,
      finder: { find: async () => PICKS },
      // A wall that never closes: the search wins on its own merits rather than by the
      // clock being rigged in its favour.
      wall: () => new Promise<void>(() => {}),
    });

    expect(call.toolResult()).toEqual({ found: true, picks: PICKS.picks });
    expect(call.spoken).toContain('Saturdays at nine fifteen');

    // A find with a hole in it registers its own follow-up (activity/tools.ts); this one
    // published both a time and a price, so nothing is owed and no text is promised.
    expect(await openCommitments(db.database, family.familyId)).toEqual([]);
  });
});
