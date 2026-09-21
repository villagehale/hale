import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { OPT_OUT_LINE, withOptOut } from '~/lib/channel/opt-out';
import {
  PROACTIVE_CAP,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { VOICE_PASS_LANES_ENV } from '~/lib/channel/voice-pass/flag';
import { type ComposeAsideInput, createVoicePass } from '~/lib/channel/voice-pass/compose';
import { loadCronSkill } from '~/lib/cron/skill';
import { handleEmailAlertOfferReply } from '~/lib/integrations/email-alert-offer';
import {
  type EmailAlertPorts,
  type GmailAlertEnvelope,
  alertParentForGmailSweep,
  renderEmailAlert,
} from '~/lib/integrations/email-alert';
import type { SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';

/**
 * THE ASIDE NEVER OPENS A DOOR — #649's regression test, standing behind a feature that
 * could reintroduce it.
 *
 * WHAT #649 WAS. An email alert ended "Reply YES and it goes on your week." with no row
 * behind it. A parent who did exactly what the text told them to do reached the coach with
 * nothing drafted — or, with one unrelated action pending, APPROVED THAT ONE (rule #4).
 * The fix was an offer written down at send time, and the rule that falls out of it is
 * that Hale asks for a YES if and only if a row exists to catch one.
 *
 * WHY A MODEL-WRITTEN CLAUSE PUTS THAT BACK IN REACH. `Say the word and it goes on your
 * week.` carries no digit, no link, no question mark, one sentence-initial capital and a
 * full stop. It passes every rule a "does this look like a question" guard would write,
 * and it is an invitation. The three door refusals exist for it, and this file is what
 * proves they run in the real send path rather than only in a unit test.
 *
 * WHAT IS REAL HERE: the outbound chokepoint and its 3-per-24h cap, both renderers, the
 * shipped guard, the shipped composer with its own agent_runs row, the ledger, the thread,
 * the audit row, and the bare-YES resolution over real Postgres. The two Fakes are the two
 * that leave the building — the SMS wire, and the model's words (rule #8: the clause's
 * QUALITY is `pnpm --filter @hale/worker eval:alert-aside`, against real cached Claude).
 */

const TZ = 'America/Toronto';
const PHONE = '+14165550188';
/** A Monday, 11:00 in Toronto — nowhere near quiet hours. */
const NOW = new Date('2026-09-21T15:00:00.000Z');

/** What a model that has learned to be helpful writes, and what must never be sent. */
const THE_DOOR = 'Say the word and it goes on your week.';

const ENVELOPES: Array<GmailAlertEnvelope & { receivedAt: string }> = [
  {
    messageId: 'm-swim',
    subject: 'CANCELLED: Sunday swim class',
    from: 'Riverside Pool <noreply@riversidepool.ca>',
    snippet: 'Sunday swim is off this week.',
    receivedAt: '1789045200000',
  },
  {
    messageId: 'm-music',
    subject: 'Thursday music circle cancelled',
    from: 'Maple Grove Daycare <office@maplegrove.ca>',
    snippet: 'No music circle Thursday.',
    receivedAt: '1789041600000',
  },
  {
    messageId: 'm-skate',
    subject: 'Friday power skating cancelled',
    from: 'Bayview Skating Club <admin@bayviewskating.ca>',
    snippet: 'The rink is closed Friday.',
    receivedAt: '1789038000000',
  },
  {
    messageId: 'm-fourth',
    subject: 'Saturday gym cancelled',
    from: 'Little Leaps Gymnastics <hello@littleleaps.ca>',
    snippet: 'No gym Saturday.',
    receivedAt: '1789034400000',
  },
];

/** A cancellation carries no offer, so none of these four mints an open question — which
 * is exactly the household state a soliciting clause would be lying to. */
function classification(envelope: { messageId: string; subject: string }): SentinelClassification {
  return {
    status: 'classified',
    familyId: '',
    messageId: envelope.messageId,
    extraction: {
      kind: 'cancellation',
      teenContent: false,
      confidence: 'high',
      matchedEventRef: null,
      quoteEvidence: null,
      event: {
        title: envelope.subject.replace(/^CANCELLED:\s*/i, ''),
        childRef: null,
        originalTime: '2026-09-26T13:00:00.000Z',
        newTime: null,
        location: null,
      },
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  } as unknown as SentinelClassification;
}

function doorSayingClient(): AgentClient {
  return {
    messages: {
      create: async () =>
        ({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [
            { type: 'tool_use', id: 't1', name: 'aside', input: { clause: THE_DOOR, place: 'after' } },
          ],
          usage: { input_tokens: 1300, output_tokens: 12 },
        }) as unknown as Anthropic.Message,
    },
  } as unknown as AgentClient;
}

describe('the aside never opens a door', () => {
  let db: TestDb;
  let database: Database;
  let familyId: string;
  let parentUserId: string;
  let integrationId: string;

  beforeEach(async () => {
    db = await createTestDb();
    database = db.database;
    vi.stubEnv('F14_ENABLED', 'true');
    // ARMED. Every other suite in this repo runs with the pass dark; this one flips it.
    vi.stubEnv(VOICE_PASS_LANES_ENV, 'email_alert');
    const seeded = await seedFamily(database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    integrationId = await seedIntegration(database, familyId, parentUserId, 'gmail');
  }, 60_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  /**
   * THE REAL PORTS with three overrides, and the three are the ones this journey is not
   * about: enrolment, watch consent and the wall clock. `countProactiveSends` stays REAL,
   * so the fourth email is held by the same query production runs over the same ledger
   * this sweep is writing — a fake count here would have made the cap assertion a test of
   * the fake.
   */
  function gatePorts() {
    return {
      ...buildOutboundGatePorts(database),
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      parentTimeZone: async () => TZ,
    };
  }

  interface Run {
    transport: FakeTransport;
    asideCalls: ComposeAsideInput[];
    ports: EmailAlertPorts;
  }

  async function run(): Promise<Run> {
    const transport = new FakeTransport();
    const asideCalls: ComposeAsideInput[] = [];
    const pass = createVoicePass({
      database,
      client: () => doorSayingClient(),
      loadSkill: () => loadCronSkill('alert-aside'),
    });
    const ports: EmailAlertPorts = {
      classify: async (envelope) => classification(envelope),
      gate: (request) => assertProactiveSendAllowed(request, gatePorts()),
      resolvePhone: async () => PHONE,
      transport,
      threadMessage: threadProactiveMessage,
      timeZone: async () => TZ,
      aside: {
        compose: async (input) => {
          asideCalls.push(input);
          return await pass.compose(input);
        },
      },
    };
    return { transport, asideCalls, ports };
  }

  /** What the lane would have sent without any of this — the control arm, built from the
   * REAL renderer rather than pasted. */
  function coreOf(envelope: (typeof ENVELOPES)[number]): string {
    const extraction = classification(envelope).extraction;
    if (extraction === null) throw new Error('fixture drift');
    // `going: null` is the going-dark state this journey's families are in, and `.body` is
    // the sentence the lane hands the pass — the renderer also reports what it did with
    // the count, which is the booked chain's business rather than the aside's.
    return renderEmailAlert({
      from: envelope.from,
      kind: extraction.kind,
      event: extraction.event,
      teenContent: extraction.teenContent,
      matchedEventRef: extraction.matchedEventRef,
      booked: true,
      going: null,
      timeZone: TZ,
      now: NOW,
    }).body;
  }

  it('sends three alerts word for word, holds the fourth, and leaves no YES to give', async () => {
    const { transport, asideCalls, ports } = await run();
    const outcomes = await alertParentForGmailSweep(
      database,
      {
        familyId,
        parentUserId,
        integrationId,
        seeding: false,
        envelopes: ENVELOPES,
        now: NOW,
      },
      ports,
    );

    // THE CAP IS THREE A DAY, and the fourth email of the day is held by it.
    expect(PROACTIVE_CAP.email_alert).toEqual({ max: 3, windowHours: 24 });
    expect(outcomes.map((o) => o.alert)).toEqual([
      'sent',
      'sent',
      'sent',
      'gate_refused:frequency_cap',
    ]);

    // THE MUTATION THIS FILE EXISTS FOR. Delete the door rules from guard.ts and every one
    // of these three goes red: the clause ships, and a text that says "say the word" is
    // asking for a YES with no row behind it, which IS #649.
    expect(transport.sent).toHaveLength(3);
    const bodies = transport.sent.map((s) => s.body);
    for (const envelope of ENVELOPES.slice(0, 3)) {
      const core = coreOf(envelope);
      // The core and THE CASL LINE, and nothing between or after them. Either form is
      // legal - the period grid gives this household's first proactive send of the month
      // the full line and the rest the short one - and neither leaves room for a clause.
      expect(
        bodies.includes(withOptOut(core, 'full')) || bodies.includes(withOptOut(core, 'short')),
      ).toBe(true);
    }
    for (const sent of transport.sent) {
      expect(sent.body).not.toContain('Say the word');
      expect(sent.body).toContain(OPT_OUT_LINE.slice(-'STOP to opt out.'.length));
    }

    // THE PASS RAN, and it was refused for the reason it must be. Three calls, not four:
    // the held envelope never reached it, which is the cost discipline the hook's
    // placement buys.
    expect(asideCalls).toHaveLength(3);
    const tallies = outcomes.map((o) => o.aside);
    expect(tallies.slice(0, 3)).toEqual(
      Array.from({ length: 3 }, () => ({
        outcome: 'refused',
        refusals: ['solicits_reply', 'addresses_the_parent'],
      })),
    );
    // `null` for the held one: it never reached the pass, which is a different fact from
    // any of the eight outcomes (rule #11).
    expect(tallies[3]).toBeNull();

    // THE THREAD AGREES WITH THE HANDSET — the coach re-reads these rows next turn, and a
    // thread that disagreed with the phone is the failure no query would otherwise show.
    const threaded = (
      await database
        .select({ body: schema.messages.content })
        .from(schema.messages)
    ).map((row) => row.body);
    for (const envelope of ENVELOPES.slice(0, 3)) {
      expect(threaded).toContain(coreOf(envelope));
    }
    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    const sentRows = audits.filter((row) => row.actionTaken === 'email_alert_sent');
    expect(sentRows).toHaveLength(3);
    for (const row of sentRows) {
      expect((row.after as Record<string, unknown>).aside).toBe(false);
      expect(JSON.stringify(row.after)).not.toContain('Say the word');
    }

    // THE FAR SIDE, and it is the only assertion here that reads the parent's next turn.
    // Three cancellations mint no offer, so the household has nothing open — and the text
    // that went out asked for nothing, so there is no YES to give. A clause that HAD
    // shipped would have asked for one anyway, which is the whole of #649.
    const reply = await handleEmailAlertOfferReply(database, {
      familyId,
      parentUserId,
      offerId: null,
      polarity: 'yes',
      language: 'en',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(reply.status).toBe('no_open_offer');
    const events = await database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, familyId));
    expect(events).toHaveLength(0);
  });

  it('bills exactly one agent_runs row per text that reached the model, and none for the held one', async () => {
    const { ports } = await run();
    await alertParentForGmailSweep(
      database,
      { familyId, parentUserId, integrationId, seeding: false, envelopes: ENVELOPES, now: NOW },
      ports,
    );
    const runs = await database
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.familyId, familyId));
    // Three, not four. A fourth row means the hook drifted above the gate or the claim,
    // and the per-alert cost this feature is judged on stops being answerable.
    expect(runs).toHaveLength(3);
    expect(runs.every((row) => row.agentName === 'voice-pass')).toBe(true);
    expect(runs.every((row) => row.status === 'failed')).toBe(true);
  });
});
