import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  aggregatePapercuts,
  formatPapercutDigest,
  runPapercutDigestCron,
  type PapercutDigestSender,
  type PapercutSendOutcome,
  type PapercutSummary,
} from './papercut-digest';

/**
 * The papercut recorder's weekly read — against a REAL Postgres (pglite + the
 * production migrations), because what is under test IS the SQL: window predicates,
 * partial-column filters (`unmet_lane IS NOT NULL`, `medical_reply_source = 'fixed'`),
 * a jsonb reason extraction, and the closed agent-name scope. A Drizzle chain fake
 * returns whatever it was handed and cannot fail any of those.
 */

const WINDOW_END = new Date('2026-08-31T16:00:00Z');
const WINDOW_START = new Date('2026-08-24T16:00:00Z');
const IN_WINDOW = new Date('2026-08-28T10:00:00Z');
const BEFORE_WINDOW = new Date('2026-08-20T10:00:00Z');

/** A parent's verbatim words, seeded on an inbound row. The redaction test's subject:
 * this string must never appear in the digest, while its bucket's count must. */
const PARENT_TEXT = 'my daughter Maeve has a rash on her tummy, should I worry?';

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeEach(async () => {
  db = await createTestDb();
  family = await seedFamily(db.database);
});

afterEach(async () => {
  await db.close();
});

async function seedInboundUnmet(
  category: 'weather' | 'nearby-places' | 'medical-symptom',
  createdAt: Date,
  body = PARENT_TEXT,
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      unmetLane: 'off_domain_general',
      unmetCategory: category,
      createdAt,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seed insert returned no row');
  return row.id;
}

async function seedOutboundReply(
  values: {
    medicalReplySource?: 'web_grounded' | 'fixed';
    replySource?: 'composed' | 'model_failed' | 'unsendable';
  },
  createdAt: Date,
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      body: null,
      medicalReplySource: values.medicalReplySource ?? null,
      replySource: values.replySource ?? null,
      createdAt,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seed insert returned no row');
  return row.id;
}

async function seedAgentRun(
  agentName: 'weekly-plan-voice' | 'nudge-voice' | 'coach',
  status: 'failed' | 'completed',
  startedAt: Date,
): Promise<string> {
  const [row] = await db.database
    .insert(schema.agentRuns)
    .values({
      familyId: family.familyId,
      agentName,
      modelUsed: 'claude-haiku-4-5',
      status,
      startedAt,
    })
    .returning({ id: schema.agentRuns.id });
  if (!row) throw new Error('seed insert returned no row');
  return row.id;
}

async function seedTurnFailure(
  reason: 'apology_sent' | 'smoke_alarm',
  occurredAt: Date,
): Promise<string> {
  const targetId = crypto.randomUUID();
  await db.database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: family.parentUserId,
    actionTaken: 'sms_turn_failed',
    targetTable: 'channel_messages',
    targetId,
    after: { lane: 'coach', reason },
    occurredAt,
  });
  return targetId;
}

function bucket(summary: PapercutSummary, source: string, label: string) {
  return summary.buckets.find((b) => b.source === source && b.bucket === label);
}

describe('aggregatePapercuts — exact counts per source, window-bounded', () => {
  it('counts unmet-intent stamps by lane · category with the inbound row ids', async () => {
    const id1 = await seedInboundUnmet('weather', IN_WINDOW);
    const id2 = await seedInboundUnmet('weather', IN_WINDOW);
    const id3 = await seedInboundUnmet('nearby-places', IN_WINDOW);
    await seedInboundUnmet('weather', BEFORE_WINDOW); // outside — must not count

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);

    const weather = bucket(summary, 'unmet_intent', 'off_domain_general · weather');
    expect(weather?.count).toBe(2);
    expect(weather?.rowIds.slice().sort()).toEqual([id1, id2].sort());
    const nearby = bucket(summary, 'unmet_intent', 'off_domain_general · nearby-places');
    expect(nearby?.count).toBe(1);
    expect(nearby?.rowIds).toEqual([id3]);
  });

  it('counts only the FIXED medical fallbacks, never the grounded answers', async () => {
    const fixed1 = await seedOutboundReply({ medicalReplySource: 'fixed' }, IN_WINDOW);
    const fixed2 = await seedOutboundReply({ medicalReplySource: 'fixed' }, IN_WINDOW);
    await seedOutboundReply({ medicalReplySource: 'web_grounded' }, IN_WINDOW);
    await seedOutboundReply({ medicalReplySource: 'fixed' }, BEFORE_WINDOW);

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);

    const fallback = bucket(summary, 'medical_fallback', 'fixed');
    expect(fallback?.count).toBe(2);
    expect(fallback?.rowIds.slice().sort()).toEqual([fixed1, fixed2].sort());
    expect(bucket(summary, 'medical_fallback', 'web_grounded')).toBeUndefined();
  });

  it('counts reply-source fallbacks by reason, never the composed answers', async () => {
    const failed = await seedOutboundReply({ replySource: 'model_failed' }, IN_WINDOW);
    await seedOutboundReply({ replySource: 'composed' }, IN_WINDOW);

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);

    const modelFailed = bucket(summary, 'reply_fallback', 'model_failed');
    expect(modelFailed?.count).toBe(1);
    expect(modelFailed?.rowIds).toEqual([failed]);
    expect(bucket(summary, 'reply_fallback', 'composed')).toBeUndefined();
  });

  it('counts failed loop-voice runs per agent, and nothing outside that closed family', async () => {
    const run1 = await seedAgentRun('weekly-plan-voice', 'failed', IN_WINDOW);
    const run2 = await seedAgentRun('weekly-plan-voice', 'failed', IN_WINDOW);
    await seedAgentRun('weekly-plan-voice', 'completed', IN_WINDOW);
    const run3 = await seedAgentRun('nudge-voice', 'failed', IN_WINDOW);
    // v1 scope pin: a failed coach run is real but is not source F (the loop voice
    // family); widening the family is a deliberate edit to VOICE_FAILURE_AGENTS.
    await seedAgentRun('coach', 'failed', IN_WINDOW);
    await seedAgentRun('weekly-plan-voice', 'failed', BEFORE_WINDOW);

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);

    const weekVoice = bucket(summary, 'voice_failure', 'weekly-plan-voice');
    expect(weekVoice?.count).toBe(2);
    expect(weekVoice?.rowIds.slice().sort()).toEqual([run1, run2].sort());
    expect(bucket(summary, 'voice_failure', 'nudge-voice')?.rowIds).toEqual([run3]);
    expect(bucket(summary, 'voice_failure', 'coach')).toBeUndefined();
  });

  it('counts sms_turn_failed audit rows by reason with the inbound message id they point at', async () => {
    const t1 = await seedTurnFailure('apology_sent', IN_WINDOW);
    const t2 = await seedTurnFailure('apology_sent', IN_WINDOW);
    const t3 = await seedTurnFailure('smoke_alarm', IN_WINDOW);
    await seedTurnFailure('apology_sent', BEFORE_WINDOW);
    // A turn that ANSWERED is not a papercut, whatever else shares the table.
    await db.database.insert(schema.auditLog).values({
      familyId: family.familyId,
      actor: family.parentUserId,
      actionTaken: 'sms_turn_answered',
      targetTable: 'channel_messages',
      targetId: crypto.randomUUID(),
      occurredAt: IN_WINDOW,
    });

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);

    const apology = bucket(summary, 'turn_failure', 'apology_sent');
    expect(apology?.count).toBe(2);
    expect(apology?.rowIds.slice().sort()).toEqual([t1, t2].sort());
    expect(bucket(summary, 'turn_failure', 'smoke_alarm')?.rowIds).toEqual([t3]);
  });

  it('reports an untouched week as no buckets at all', async () => {
    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);
    expect(summary.buckets).toEqual([]);
  });
});

describe('formatPapercutDigest — categories, counts and row ids; never a parent word', () => {
  it('carries the bucket count (positive control) and not one word the parent typed', async () => {
    const id = await seedInboundUnmet('medical-symptom', IN_WINDOW, PARENT_TEXT);

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);
    const digest = formatPapercutDigest(summary);

    // Positive control first: the bucket landed, so an absent body below is redaction
    // working rather than an aggregation that read nothing.
    expect(digest).toContain('off_domain_general · medical-symptom: 1');
    expect(digest).toContain(id);
    expect(digest).not.toContain('Maeve');
    expect(digest).not.toContain('rash');
    expect(digest).not.toContain(PARENT_TEXT);
  });

  it('lists at most a handful of row ids per bucket and says how many more there are', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(await seedInboundUnmet('weather', IN_WINDOW));
    }

    const summary = await aggregatePapercuts(db.database, WINDOW_START, WINDOW_END);
    const digest = formatPapercutDigest(summary);

    expect(digest).toContain('off_domain_general · weather: 12');
    expect(digest).toContain('+2 more');
    const listed = ids.filter((id) => digest.includes(id));
    expect(listed).toHaveLength(10);
  });
});

/** A sender that records what it was asked to send and answers as told. */
function fakeSender(outcome: PapercutSendOutcome = { sent: true }): PapercutDigestSender & {
  bodies: string[];
} {
  const sender = {
    bodies: [] as string[],
    async send(body: string) {
      sender.bodies.push(body);
      return outcome;
    },
  };
  return sender;
}

describe('runPapercutDigestCron — named outcomes, never an empty email', () => {
  it('aggregates the trailing week and sends one digest through the sender', async () => {
    await seedInboundUnmet('weather', IN_WINDOW);
    const sender = fakeSender();

    const result = await runPapercutDigestCron(
      db.database,
      { aggregate: aggregatePapercuts, sender },
      WINDOW_END,
    );

    expect(result.outcome).toBe('sent');
    expect(sender.bodies).toHaveLength(1);
    expect(sender.bodies[0]).toContain('papercuts');
    expect(sender.bodies[0]).toContain('off_domain_general · weather: 1');
  });

  it('skips an empty week by name and never wakes the sender', async () => {
    const sender = fakeSender();

    const result = await runPapercutDigestCron(
      db.database,
      { aggregate: aggregatePapercuts, sender },
      WINDOW_END,
    );

    expect(result.outcome).toBe('digest_skipped_empty');
    expect(sender.bodies).toHaveLength(0);
  });

  it('names a sender with nowhere to send (rule #11), rather than folding it into failure', async () => {
    await seedInboundUnmet('weather', IN_WINDOW);
    const sender = fakeSender({ sent: false, reason: 'not_configured' });

    const result = await runPapercutDigestCron(
      db.database,
      { aggregate: aggregatePapercuts, sender },
      WINDOW_END,
    );

    expect(result.outcome).toBe('send_skipped_not_configured');
  });

  it('names a provider refusal as a failed send', async () => {
    await seedInboundUnmet('weather', IN_WINDOW);
    const sender = fakeSender({ sent: false, reason: 'provider_error' });

    const result = await runPapercutDigestCron(
      db.database,
      { aggregate: aggregatePapercuts, sender },
      WINDOW_END,
    );

    expect(result.outcome).toBe('send_failed');
  });
});
