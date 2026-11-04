import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { seedCanaryHousehold } from '~/lib/channel/canary/seed';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { TURN_DEFERRED_ACTION, TURN_FAILED_ACTION } from '~/lib/channel/router/wiring';
import {
  type CrisisPager,
  type SaidLineWriter,
  deliverCrisisReply,
} from '~/lib/channel/voice/said-line';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CLAIM_EPOCH,
  CRISIS_UNANSWERED_AUDIT_ACTION,
  CRISIS_UNANSWERED_PAGE_ROUTE,
  DEAD_LETTER_PAGE_ROUTE,
  DEFERRED_PILEUP_PAGE_ROUTE,
  DEFERRED_PILEUP_THRESHOLD,
  FIRST_HELLO_PAGE_ROUTE,
  MODEL_PROVIDER,
  OPT_OUT_HOLD_PAGE_ROUTE,
  OPT_OUT_LATE_CRISIS_ROUTE,
  PROVIDER_INCIDENT_PAGE_ROUTE,
  TURN_DEFERRED_AUDIT_ACTION,
  TURN_FAILED_AUDIT_ACTION,
  TURN_FAILURE_PAGE_ROUTE,
  claimStamp,
  composeCrisisUnansweredAlert,
  composeDeadLetterAlert,
  composeDeferredPileupAlert,
  composeFirstHelloFailureAlert,
  composeOptOutHoldAlert,
  composeProviderIncidentAlert,
  composeTurnFailureAlert,
  failureCategory,
  failurePageCrisisPager,
  firstHelloFailureCategory,
  noteDeadLetteredTurn,
  noteFirstHelloFailure,
  pageFailureAlerts,
} from './failure-page';
import type { IncidentFailure } from './provider-health';

/**
 * VIL-404 — a failed turn and a failed first hello each page Slack #ops once.
 * The page names a family and a category. It does not name a phone or a
 * parent's words. Dedup is the rate_limits claim, proven here against real DDL.
 */

const NOW = new Date('2026-10-02T12:00:00.000Z');
const PHONE_SHAPED = '+14165550199';
const PARENT_WORDS = 'the secret phrase about nap time';

function recorder(decide: (nth: number) => 'sent' | 'failed' = () => 'sent') {
  const texts: string[] = [];
  const post = async (text: string) => {
    texts.push(text);
    return decide(texts.length);
  };
  return { texts, post };
}

function assertNoParentPayload(text: string, ...allowedIds: string[]) {
  let stripped = text;
  for (const id of allowedIds) stripped = stripped.replaceAll(id, '');
  expect(stripped).not.toMatch(/\d{7,}/);
  expect(text).not.toContain(PHONE_SHAPED);
  expect(text).not.toContain(PARENT_WORDS);
  expect(text).not.toContain(PHONE_SHAPED.replace('+', ''));
}

describe('failure page copy', () => {
  it('uses the same audit action the turn ledger writes', () => {
    expect(TURN_FAILED_AUDIT_ACTION).toBe(TURN_FAILED_ACTION);
    expect(TURN_DEFERRED_AUDIT_ACTION).toBe(TURN_DEFERRED_ACTION);
  });

  it('keeps a short provider code and redacts a phone-shaped category', () => {
    expect(failureCategory('broke_after_answering')).toBe('broke_after_answering');
    expect(failureCategory('21610')).toBe('21610');
    expect(failureCategory(PHONE_SHAPED)).toBe('redacted');
    const cleaned = failureCategory(`Linq said ${PARENT_WORDS}`);
    expect(cleaned.startsWith('linq_said')).toBe(true);
    expect(cleaned.length).toBeLessThanOrEqual(40);
    expect(cleaned).not.toContain(' ');
  });

  it('categories a Linq refusal by its code and any other throw by its name', () => {
    expect(firstHelloFailureCategory(new LinqSendError('not_configured', 0, true))).toBe(
      'not_configured',
    );
    expect(firstHelloFailureCategory(new Error(`${PARENT_WORDS} ${PHONE_SHAPED}`))).toBe('error');
    expect(firstHelloFailureCategory('nope')).toBe('unknown');
  });

  it('names the family and the category, and drops anything that is not a uuid', () => {
    const familyId = randomUUID();
    const messageId = randomUUID();
    const text = composeTurnFailureAlert({
      familyId,
      category: 'broke_after_answering',
      messageId,
    });
    expect(text).toContain(familyId);
    expect(text).toContain('broke_after_answering');
    expect(text).toContain(messageId);
    expect(text).not.toContain(PHONE_SHAPED);

    const dropped = composeTurnFailureAlert({
      familyId: PHONE_SHAPED,
      category: PHONE_SHAPED,
      messageId: PARENT_WORDS,
    });
    expect(dropped).toContain('family invalid');
    expect(dropped).toContain('category redacted');
    expect(dropped).not.toContain(PHONE_SHAPED);
    expect(dropped).not.toContain(PARENT_WORDS);
  });

  it('says family none when a first hello has no family yet', () => {
    const sessionId = randomUUID();
    const text = composeFirstHelloFailureAlert({
      familyId: null,
      sessionId,
      category: 'not_configured',
    });
    expect(text).toContain('family none');
    expect(text).toContain(sessionId);
    expect(text).toContain('not_configured');
    assertNoParentPayload(text, sessionId);
  });

  it('names the provider, the class, and a turn count, and drops a phone-shaped provider', () => {
    const text = composeProviderIncidentAlert({
      provider: 'anthropic',
      failure: 'billing',
      affectedTurns: 3,
    });
    expect(text).toContain('provider anthropic');
    expect(text).toContain('class billing');
    expect(text).toContain('affected turns 3');
    assertNoParentPayload(text);

    const leaked = composeProviderIncidentAlert({
      provider: PHONE_SHAPED,
      failure: PARENT_WORDS,
      affectedTurns: 1,
    });
    expect(leaked).toContain('provider redacted');
    expect(leaked).not.toContain(PHONE_SHAPED);
    expect(leaked).not.toContain(PARENT_WORDS);
  });

  it('names a dead-lettered turn by internal ids and omits a phone-shaped job id', () => {
    const familyId = randomUUID();
    const messageId = randomUUID();
    const text = composeDeadLetterAlert({
      familyId,
      channelMessageId: messageId,
      jobId: 'job-1',
    });
    expect(text).toContain(familyId);
    expect(text).toContain(messageId);
    expect(text).toContain('job job-1');
    assertNoParentPayload(text, familyId, messageId);

    const dropped = composeDeadLetterAlert({
      familyId: PHONE_SHAPED,
      channelMessageId: PARENT_WORDS,
      jobId: PHONE_SHAPED.replace('+', ''),
    });
    expect(dropped).toContain('family invalid');
    expect(dropped).toContain('message invalid');
    expect(dropped).not.toContain(PHONE_SHAPED);
    expect(dropped).not.toContain('14165550199');
  });

  it('names a deferral pile-up by count and window', () => {
    const text = composeDeferredPileupAlert({ count: 8, windowMinutes: 60 });
    expect(text).toContain('count 8');
    expect(text).toContain('window 60m');
    assertNoParentPayload(text);
  });
});

describe('pageFailureAlerts (real DDL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedTurn(
    family: { familyId: string; parentUserId: string },
    reason: string,
    over: { occurredAt?: Date; actionTaken?: string; echo?: string } = {},
  ) {
    const [row] = await db.database
      .insert(schema.auditLog)
      .values({
        familyId: family.familyId,
        actor: family.parentUserId,
        actionTaken: over.actionTaken ?? TURN_FAILED_AUDIT_ACTION,
        targetTable: 'channel_messages',
        targetId: randomUUID(),
        after: { lane: 'coach', reason, echo: over.echo ?? null },
        occurredAt: over.occurredAt ?? NOW,
      })
      .returning({ id: schema.auditLog.id, targetId: schema.auditLog.targetId });
    if (!row) throw new Error('seedTurn: no row');
    return row;
  }

  it('pages broke_after_answering once, with family and category, and a second sweep is quiet', async () => {
    const family = await seedFamily(db.database, 'Failed Turn');
    const row = await seedTurn(family, 'broke_after_answering', { echo: PARENT_WORDS });
    const { texts, post } = recorder();

    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(first.turns.posted).toBe(1);
    expect(second.turns).toEqual({ posted: 0, deduped: 0, failed: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(family.familyId);
    expect(texts[0]).toContain('broke_after_answering');
    expect(texts[0]).toContain(row.targetId);
    assertNoParentPayload(texts[0] ?? '', family.familyId, row.targetId ?? '');
  });

  it('pages every failed-turn reason, and does not page a deferral or an old row', async () => {
    const family = await seedFamily(db.database, 'Other Reasons');
    await seedTurn(family, 'apology_sent');
    await seedTurn(family, 'smoke_alarm');
    await seedTurn(family, 'model_unreachable', { actionTaken: 'sms_turn_deferred' });
    await seedTurn(family, 'broke_after_answering', {
      occurredAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
    });
    const { texts, post } = recorder();

    const result = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(result.turns.posted).toBe(2);
    expect(
      texts.map((text) => text.includes('apology_sent') || text.includes('smoke_alarm')),
    ).toEqual([true, true]);
    expect(texts.join(' ')).not.toContain('model_unreachable');
  });

  it('retries a turn whose Slack post did not land, and does not retry one already claimed', async () => {
    const family = await seedFamily(db.database, 'Retry Turn');
    await seedTurn(family, 'drafts_receipt');
    const flaky = recorder((nth) => (nth === 1 ? 'failed' : 'sent'));

    const first = await pageFailureAlerts(db.database, { post: flaky.post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post: flaky.post, now: NOW });

    expect(first.turns.failed).toBe(1);
    expect(second.turns.posted).toBe(1);
    expect(flaky.texts).toHaveLength(2);

    const busy = await seedFamily(db.database, 'Busy Turn');
    const held = await seedTurn(busy, 'unplaced_choice');
    await db.database.insert(schema.rateLimits).values({
      identifier: held.id,
      route: TURN_FAILURE_PAGE_ROUTE,
      windowStart: new Date(0),
      count: Math.floor(NOW.getTime() / 1000),
    });
    const quiet = recorder();
    const heldBack = await pageFailureAlerts(db.database, { post: quiet.post, now: NOW });
    expect(quiet.texts).toEqual([]);
    expect(heldBack.turns.deduped).toBe(1);
  });

  it('reclaims a crashed in-progress turn claim and posts it', async () => {
    const family = await seedFamily(db.database, 'Stale Turn');
    const row = await seedTurn(family, 'broke_after_answering');
    await db.database.insert(schema.rateLimits).values({
      identifier: row.id,
      route: TURN_FAILURE_PAGE_ROUTE,
      windowStart: new Date(0),
      count: Math.floor((NOW.getTime() - 10 * 60 * 1000) / 1000),
    });
    const { texts, post } = recorder();

    const result = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(result.turns.posted).toBe(1);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(family.familyId);
  });

  it('pages a failed first hello with family none, once, and retries when Slack refuses', async () => {
    const sessionId = randomUUID();
    const { texts, post } = recorder();

    const first = await noteFirstHelloFailure(
      db.database,
      { sessionId, familyId: null, category: 'not_configured' },
      { post, now: NOW },
    );
    const second = await noteFirstHelloFailure(
      db.database,
      { sessionId, familyId: null, category: 'timeout' },
      { post, now: NOW },
    );

    expect(first.firstHellos.posted).toBe(1);
    expect(second.firstHellos.posted).toBe(0);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('family none');
    expect(texts[0]).toContain(sessionId);
    expect(texts[0]).toContain('not_configured');
    expect(texts[0]).not.toContain('timeout');
    assertNoParentPayload(texts[0] ?? '', sessionId);

    const refused = recorder((nth) => (nth === 1 ? 'failed' : 'sent'));
    const other = randomUUID();
    const failed = await noteFirstHelloFailure(
      db.database,
      { sessionId: other, familyId: null, category: 'error' },
      { post: refused.post, now: NOW },
    );
    const retried = await pageFailureAlerts(db.database, { post: refused.post, now: NOW });
    expect(failed.firstHellos.failed).toBe(1);
    expect(retried.firstHellos.posted).toBe(1);
    expect(refused.texts).toHaveLength(2);
  });

  it('includes the family id once the session has one, and refuses a phone as a session id', async () => {
    const family = await seedFamily(db.database, 'Hello Family');
    const sessionId = randomUUID();
    await db.database.insert(schema.smsIntakeSessions).values({
      id: sessionId,
      phoneHash: `hash-${sessionId}`,
      phoneEncrypted: 'enc',
      state: 'awaiting_details',
      dataEncrypted: 'enc',
      familyId: family.familyId,
    });
    const { texts, post } = recorder();

    await noteFirstHelloFailure(
      db.database,
      { sessionId, familyId: family.familyId, category: 'error' },
      { post, now: NOW },
    );

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(family.familyId);
    expect(texts[0]).toContain(sessionId);
    assertNoParentPayload(texts[0] ?? '', family.familyId, sessionId);

    const leaked = recorder();
    await noteFirstHelloFailure(
      db.database,
      { sessionId: PHONE_SHAPED, familyId: null, category: 'error' },
      { post: leaked.post, now: NOW },
    );
    expect(leaked.texts.join(' ')).not.toContain(PHONE_SHAPED);
    const claims = await db.database
      .select({
        identifier: schema.rateLimits.identifier,
        route: schema.rateLimits.route,
      })
      .from(schema.rateLimits);
    expect(claims.some((row) => row.identifier.includes(PHONE_SHAPED.replace('+', '')))).toBe(
      false,
    );
    expect(claims.some((row) => row.identifier.startsWith(`${sessionId}:`))).toBe(true);
    expect(claims.some((row) => row.route === FIRST_HELLO_PAGE_ROUTE)).toBe(true);
  });
});

describe('provider incidents, dead letters, and deferral pile-ups', () => {
  let db: TestDb;
  const KEY = Buffer.alloc(32, 9).toString('base64');

  beforeEach(async () => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
    Reflect.deleteProperty(process.env, 'APP_ENCRYPTION_KEY');
  });

  async function seedDeferred(
    family: { familyId: string; parentUserId: string },
    over: { providerFailure?: IncidentFailure; targetId?: string; occurredAt?: Date } = {},
  ) {
    const [row] = await db.database
      .insert(schema.auditLog)
      .values({
        familyId: family.familyId,
        actor: family.parentUserId,
        actionTaken: TURN_DEFERRED_AUDIT_ACTION,
        targetTable: 'channel_messages',
        targetId: over.targetId ?? randomUUID(),
        after: over.providerFailure
          ? { providerFailure: over.providerFailure }
          : { reason: 'model_failed' },
        occurredAt: over.occurredAt ?? NOW,
      })
      .returning({ id: schema.auditLog.id, targetId: schema.auditLog.targetId });
    if (!row) throw new Error('seedDeferred: no row');
    return row;
  }

  it('pages a billing incident once, with the provider, the class, and the turn count', async () => {
    const family = await seedFamily(db.database, 'Billing');
    const other = await seedFamily(db.database, 'Billing Two');
    const messageId = randomUUID();
    await seedDeferred(family, { providerFailure: 'billing', targetId: messageId });
    await seedDeferred(family, { providerFailure: 'billing', targetId: messageId });
    await seedDeferred(other, { providerFailure: 'billing' });
    await seedDeferred(family, { providerFailure: 'auth' });
    const { texts, post } = recorder();

    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(first.providerIncidents.posted).toBe(2);
    expect(second.providerIncidents).toEqual({ posted: 0, deduped: 2, failed: 0 });
    const billing = texts.find((text) => text.includes('class billing'));
    const auth = texts.find((text) => text.includes('class auth'));
    expect(billing).toContain('provider anthropic');
    expect(billing).toContain('affected turns 2');
    expect(auth).toContain('affected turns 1');
    expect(texts.join(' ')).not.toContain(PHONE_SHAPED);
    expect(texts.join(' ')).not.toContain(PARENT_WORDS);
    expect(texts.join(' ')).not.toContain(messageId);
  });

  it('pages a usage-limit incident once, with the provider, the class, and the turn count', async () => {
    const family = await seedFamily(db.database, 'Usage Limit');
    const other = await seedFamily(db.database, 'Usage Limit Two');
    const messageId = randomUUID();
    await seedDeferred(family, { providerFailure: 'usage_limit', targetId: messageId });
    await seedDeferred(family, { providerFailure: 'usage_limit', targetId: messageId });
    await seedDeferred(other, { providerFailure: 'usage_limit' });
    const { texts, post } = recorder();

    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(first.providerIncidents).toEqual({ posted: 1, deduped: 0, failed: 0 });
    expect(second.providerIncidents).toEqual({ posted: 0, deduped: 1, failed: 0 });
    expect(texts).toHaveLength(1);
    const [page] = texts;
    expect(page).toContain('provider anthropic');
    expect(page).toContain('class usage_limit');
    expect(page).toContain('affected turns 2');
    assertNoParentPayload(page ?? '');
    expect(page).not.toContain(messageId);
    expect(page).not.toContain(family.familyId);
  });

  it('does not page a deferral that is not billing or auth', async () => {
    const family = await seedFamily(db.database, 'Ordinary Deferral');
    await seedDeferred(family);
    const { texts, post } = recorder();

    const result = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(result.providerIncidents).toEqual({ posted: 0, deduped: 0, failed: 0 });
    expect(texts).toEqual([]);
  });

  it('retries a provider page whose Slack post did not land', async () => {
    const family = await seedFamily(db.database, 'Retry Billing');
    await seedDeferred(family, { providerFailure: 'billing' });
    const flaky = recorder((nth) => (nth === 1 ? 'failed' : 'sent'));

    const first = await pageFailureAlerts(db.database, { post: flaky.post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post: flaky.post, now: NOW });

    expect(first.providerIncidents.failed).toBe(1);
    expect(second.providerIncidents.posted).toBe(1);
    expect(flaky.texts).toHaveLength(2);
  });

  it('does not page or count a canary billing deferral', async () => {
    const seeded = await seedCanaryHousehold(db.database);
    if (seeded.status !== 'created') throw new Error(`canary seed: ${seeded.status}`);
    const channels = await db.database
      .select({
        userId: schema.parentChannels.userId,
        familyId: schema.parentChannels.familyId,
      })
      .from(schema.parentChannels);
    const canary = channels.find((row) => row.familyId === seeded.familyId);
    if (!canary) throw new Error('canary channel missing');
    await seedDeferred(
      { familyId: seeded.familyId, parentUserId: canary.userId },
      { providerFailure: 'billing' },
    );
    const quiet = recorder();
    const onlyCanary = await pageFailureAlerts(db.database, { post: quiet.post, now: NOW });
    expect(onlyCanary.providerIncidents.posted).toBe(0);
    expect(quiet.texts).toEqual([]);

    const family = await seedFamily(db.database, 'Real Billing');
    await seedDeferred(family, { providerFailure: 'billing' });
    const { texts, post } = recorder();
    const withParent = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(withParent.providerIncidents.posted).toBe(1);
    expect(texts[0]).toContain('affected turns 1');
    expect(texts[0]).not.toContain(CANARY_PHONE_E164);
    expect(texts[0]).not.toContain(seeded.familyId);
  });

  it('pages a dead-lettered turn once, by internal ids, and retries a refused post', async () => {
    const family = await seedFamily(db.database, 'Dead Letter');
    const messageId = randomUUID();
    const { texts, post } = recorder();

    const first = await noteDeadLetteredTurn(
      db.database,
      { familyId: family.familyId, channelMessageId: messageId, jobId: 'job-1' },
      { post, now: NOW },
    );
    const second = await noteDeadLetteredTurn(
      db.database,
      { familyId: family.familyId, channelMessageId: messageId, jobId: 'job-1' },
      { post, now: NOW },
    );

    expect(first.deadLetters.posted).toBe(1);
    expect(second.deadLetters.posted).toBe(0);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(family.familyId);
    expect(texts[0]).toContain(messageId);
    expect(texts[0]).toContain('job job-1');
    assertNoParentPayload(texts[0] ?? '', family.familyId, messageId);

    const refused = recorder((nth) => (nth === 1 ? 'failed' : 'sent'));
    const otherMessage = randomUUID();
    const failed = await noteDeadLetteredTurn(
      db.database,
      { familyId: family.familyId, channelMessageId: otherMessage, jobId: '14165550199' },
      { post: refused.post, now: NOW },
    );
    const retried = await noteDeadLetteredTurn(
      db.database,
      { familyId: family.familyId, channelMessageId: otherMessage, jobId: '14165550199' },
      { post: refused.post, now: NOW },
    );
    expect(failed.deadLetters.failed).toBe(1);
    expect(retried.deadLetters.posted).toBe(1);
    expect(refused.texts[0]).not.toContain('14165550199');
    expect(refused.texts.join(' ')).not.toContain(PHONE_SHAPED);

    const leaked = recorder();
    await noteDeadLetteredTurn(
      db.database,
      { familyId: PHONE_SHAPED, channelMessageId: messageId, jobId: 'job-1' },
      { post: leaked.post, now: NOW },
    );
    expect(leaked.texts.join(' ')).not.toContain(PHONE_SHAPED);
    const claims = await db.database
      .select({ identifier: schema.rateLimits.identifier, route: schema.rateLimits.route })
      .from(schema.rateLimits);
    expect(
      claims.some(
        (row) => row.route === DEAD_LETTER_PAGE_ROUTE && row.identifier.includes('416555'),
      ),
    ).toBe(false);
  });

  it('does not page a canary turn that dead-lettered', async () => {
    const seeded = await seedCanaryHousehold(db.database);
    if (seeded.status !== 'created') throw new Error(`canary seed: ${seeded.status}`);
    const { texts, post } = recorder();

    const result = await noteDeadLetteredTurn(
      db.database,
      { familyId: seeded.familyId, channelMessageId: randomUUID(), jobId: 'job-1' },
      { post, now: NOW },
    );

    expect(result.deadLetters.posted).toBe(0);
    expect(texts).toEqual([]);
    const claims = await db.database
      .select({ route: schema.rateLimits.route })
      .from(schema.rateLimits);
    expect(claims.some((row) => row.route === DEAD_LETTER_PAGE_ROUTE)).toBe(false);
  });

  it('pages once when deferred turns reach the threshold, and not one under it', async () => {
    const family = await seedFamily(db.database, 'Pile');
    const quiet = recorder();
    for (let i = 0; i < DEFERRED_PILEUP_THRESHOLD - 1; i += 1) {
      await seedDeferred(family);
    }
    const under = await pageFailureAlerts(db.database, { post: quiet.post, now: NOW });
    expect(under.deferredPileups).toEqual({ posted: 0, deduped: 0, failed: 0 });
    expect(quiet.texts).toEqual([]);

    await seedDeferred(family);
    const { texts, post } = recorder();
    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const second = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(first.deferredPileups.posted).toBe(1);
    expect(second.deferredPileups).toEqual({ posted: 0, deduped: 1, failed: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`count ${DEFERRED_PILEUP_THRESHOLD}`);
    expect(texts[0]).toContain('window 60m');
    expect(texts[0]).not.toContain(family.familyId);
    assertNoParentPayload(texts[0] ?? '');
  });

  it('does not let canary deferrals fill the pile-up threshold', async () => {
    const seeded = await seedCanaryHousehold(db.database);
    if (seeded.status !== 'created') throw new Error(`canary seed: ${seeded.status}`);
    const channels = await db.database
      .select({
        userId: schema.parentChannels.userId,
        familyId: schema.parentChannels.familyId,
      })
      .from(schema.parentChannels);
    const canary = channels.find((row) => row.familyId === seeded.familyId);
    if (!canary) throw new Error('canary channel missing');
    for (let i = 0; i < DEFERRED_PILEUP_THRESHOLD; i += 1) {
      await seedDeferred({ familyId: seeded.familyId, parentUserId: canary.userId });
    }
    const { texts, post } = recorder();

    const result = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(result.deferredPileups.posted).toBe(0);
    expect(texts).toEqual([]);
    expect(texts.join(' ')).not.toContain(CANARY_PHONE_E164);
  });

  it('keeps the provider claim on its own route', async () => {
    const family = await seedFamily(db.database, 'Route');
    await seedDeferred(family, { providerFailure: 'billing' });
    await pageFailureAlerts(db.database, { post: recorder().post, now: NOW });
    const claims = await db.database
      .select({
        identifier: schema.rateLimits.identifier,
        route: schema.rateLimits.route,
      })
      .from(schema.rateLimits);
    expect(claims).toContainEqual({
      identifier: `${MODEL_PROVIDER}:billing`,
      route: PROVIDER_INCIDENT_PAGE_ROUTE,
    });
    expect(claims.some((row) => row.route === DEFERRED_PILEUP_PAGE_ROUTE)).toBe(false);
  });
});

describe('a crisis with no reply pages #ops at once (real DDL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  const DRAFT = 'Call or text 988 or see example.org';
  const INBOUND = 'provider-inbound-crisis-a';

  /** Two drafts that both fail the crisis check (a link), so nothing is sendable. */
  function failingWriter(): SaidLineWriter {
    return { write: async () => DRAFT };
  }

  async function auditActions() {
    const rows = await db.database
      .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog);
    return rows;
  }

  async function crisisClaims() {
    return db.database
      .select({ identifier: schema.rateLimits.identifier, count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE));
  }

  function crisisTurn(
    pager: CrisisPager,
    over: {
      inboundId?: string;
      familyId?: string | null;
      writer?: SaidLineWriter | null;
      where?: string;
    } = {},
  ) {
    return deliverCrisisReply({
      kind: 'mental',
      language: null,
      region: null,
      situation: null,
      who: null,
      where: over.where ?? 'intake crisis',
      inboundId: over.inboundId ?? INBOUND,
      familyId: over.familyId === undefined ? null : over.familyId,
      parentUserId: null,
      pager,
      writer: over.writer === undefined ? failingWriter() : over.writer,
    });
  }

  it('a writer that fails twice pages once, with kind, where and reason, and audits it body-free', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await seedFamily(db.database, 'Crisis Family');
    const { texts, post } = recorder();

    const outcome = await crisisTurn(failurePageCrisisPager(db.database, { post, now: NOW }), {
      familyId: family.familyId,
    });

    expect(outcome).toEqual({ status: 'unanswered', reason: 'link', page: 'paged' });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('crisis flagged, no reply sent');
    expect(texts[0]).toContain('kind mental');
    expect(texts[0]).toContain('where intake_crisis');
    expect(texts[0]).toContain('reason link');
    expect(texts[0]).toContain('writes 2');
    expect(texts[0]).not.toContain('example');
    expect(texts[0]).not.toContain('988');
    expect(texts[0]).not.toContain(family.familyId);
    expect(texts[0]).not.toContain(INBOUND);
    // The claim's random uuid can hold a run of seven digits; it is the one reference.
    assertNoParentPayload(
      texts[0] ?? '',
      ...(texts[0]?.match(/ref ([0-9a-f-]{36})\./)?.slice(1) ?? []),
    );
    const audited = (await auditActions()).filter(
      (row) => row.action === CRISIS_UNANSWERED_AUDIT_ACTION,
    );
    expect(audited).toEqual([
      {
        action: 'crisis_unanswered',
        after: { kind: 'mental', where: 'intake crisis', reason: 'link', writes: 2 },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain('example');
  });

  it('the page and the audit row do carry a word that is theirs (positive control for the absences above)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await seedFamily(db.database, 'Crisis Control');
    const { texts, post } = recorder();

    await crisisTurn(failurePageCrisisPager(db.database, { post, now: NOW }), {
      familyId: family.familyId,
      where: 'intake example',
    });

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('example');
    const audited = (await auditActions()).filter(
      (row) => row.action === CRISIS_UNANSWERED_AUDIT_ACTION,
    );
    expect(JSON.stringify(audited)).toContain('example');
  });

  it('a pager whose page throws still leaves the owed claim and the audit row, and the sweep pages it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await seedFamily(db.database, 'Crisis Throw');
    const real = failurePageCrisisPager(db.database, { post: recorder().post, now: NOW });
    const throwing: CrisisPager = {
      record: real.record,
      page: async () => {
        throw new Error('pager crashed');
      },
    };

    const outcome = await crisisTurn(throwing, { familyId: family.familyId });

    expect(outcome).toMatchObject({ status: 'unanswered', page: 'page_failed' });
    expect(await crisisClaims()).toEqual([{ identifier: expect.any(String), count: 0 }]);
    const audited = (await auditActions()).filter(
      (row) => row.action === CRISIS_UNANSWERED_AUDIT_ACTION,
    );
    expect(audited).toHaveLength(1);

    const { texts, post } = recorder();
    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(sweep.crisisUnanswered.posted).toBe(1);
    expect(texts[0]).toContain('reason link');
  });

  it('no writer, and no family yet, still pages: the claim row is the record', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { texts, post } = recorder();

    const outcome = await crisisTurn(failurePageCrisisPager(db.database, { post, now: NOW }), {
      writer: null,
    });

    expect(outcome).toEqual({ status: 'unanswered', reason: 'no_writer', page: 'paged' });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('reason no_writer');
    expect(texts[0]).toContain('writes 0');
    expect(await auditActions()).toEqual([]);
    const claims = await db.database
      .select({ route: schema.rateLimits.route, count: schema.rateLimits.count })
      .from(schema.rateLimits);
    expect(claims).toEqual([{ route: CRISIS_UNANSWERED_PAGE_ROUTE, count: 1 }]);
  });

  it('a pager that throws is page_failed, the audit row still lands, and the sweep re-pages it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await seedFamily(db.database, 'Crisis Retry');
    const throwing = async (): Promise<'sent'> => {
      throw new Error('webhook down');
    };

    const outcome = await crisisTurn(
      failurePageCrisisPager(db.database, { post: throwing, now: NOW }),
      { familyId: family.familyId },
    );

    expect(outcome).toEqual({ status: 'unanswered', reason: 'link', page: 'page_failed' });
    const audited = (await auditActions()).filter(
      (row) => row.action === CRISIS_UNANSWERED_AUDIT_ACTION,
    );
    expect(audited).toHaveLength(1);

    const { texts, post } = recorder();
    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });
    const again = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(sweep.crisisUnanswered).toEqual({ posted: 1, deduped: 0, failed: 0 });
    expect(again.crisisUnanswered).toEqual({ posted: 0, deduped: 0, failed: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('kind mental');
    expect(texts[0]).toContain('where intake_crisis');
    expect(texts[0]).toContain('reason link');
    expect(texts[0]).not.toContain('example');
  });

  it('an unconfigured webhook is named, and the page stays owed for the sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unconfigured = async () => 'skipped_not_configured' as const;

    const outcome = await crisisTurn(
      failurePageCrisisPager(db.database, { post: unconfigured, now: NOW }),
      { writer: null },
    );

    expect(outcome).toEqual({
      status: 'unanswered',
      reason: 'no_writer',
      page: 'page_not_configured',
    });
    const { texts, post } = recorder();
    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(sweep.crisisUnanswered.posted).toBe(1);
    expect(texts).toHaveLength(1);
  });

  it('the same inbound delivered twice pages once; another inbound pages again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const family = await seedFamily(db.database, 'Crisis Twice');
    const { texts, post } = recorder();
    const pager = failurePageCrisisPager(db.database, { post, now: NOW });

    const first = await crisisTurn(pager, { familyId: family.familyId });
    // A live writer is not deterministic: the redelivery fails for another reason.
    const redelivered = await crisisTurn(pager, { familyId: family.familyId, writer: null });

    expect(first).toMatchObject({ reason: 'link', page: 'paged' });
    expect(redelivered).toMatchObject({ reason: 'no_writer', page: 'already_paged' });
    expect(texts).toHaveLength(1);
    const audited = (await auditActions()).filter(
      (row) => row.action === CRISIS_UNANSWERED_AUDIT_ACTION,
    );
    expect(audited).toHaveLength(1);

    // Positive control: a different inbound is a different crisis and pages.
    const other = await crisisTurn(pager, {
      familyId: family.familyId,
      inboundId: 'provider-inbound-crisis-b',
    });
    expect(other).toMatchObject({ page: 'paged' });
    expect(texts).toHaveLength(2);
  });

  it('a redelivery that fails for another reason finds the first claim by its inbound key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unconfigured = async () => 'skipped_not_configured' as const;

    // The first delivery's page does not leave: its claim stays owed.
    const first = await crisisTurn(
      failurePageCrisisPager(db.database, { post: unconfigured, now: NOW }),
    );
    expect(first).toMatchObject({ reason: 'link', page: 'page_not_configured' });

    const { texts, post } = recorder();
    const redelivered = await crisisTurn(failurePageCrisisPager(db.database, { post, now: NOW }), {
      writer: null,
    });

    // The redelivery pages the FIRST claim, under the first reason: one row, one page.
    expect(redelivered).toMatchObject({ reason: 'no_writer', page: 'paged' });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('reason link');
    const claims = await crisisClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.identifier).toMatch(/^[0-9a-f]{32}:mental:intake_crisis:link:2$/);
    expect(claims[0]?.count).toBe(1);
    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(sweep.crisisUnanswered.posted).toBe(0);
  });

  it('a crisis claim left in progress by a crashed poster is released and paged by the sweep', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const crashedAt = Math.floor((NOW.getTime() - 3 * 60 * 1000) / 1000);
    await db.database.insert(schema.rateLimits).values({
      identifier: `${'a'.repeat(32)}:emergency:intake_crisis:no_writer:0`,
      route: CRISIS_UNANSWERED_PAGE_ROUTE,
      windowStart: CLAIM_EPOCH,
      count: crashedAt,
    });
    const { texts, post } = recorder();

    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(sweep.crisisUnanswered.posted).toBe(1);
    expect(texts[0]).toContain('kind emergency');
    expect(texts[0]).toContain('reason no_writer');
  });

  it('an owed crisis claim the sweep cannot read still pages, named unreadable and logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [claim] = await db.database
      .insert(schema.rateLimits)
      .values({
        identifier: 'not-a-crisis-key',
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        windowStart: CLAIM_EPOCH,
        count: 0,
      })
      .returning({ id: schema.rateLimits.id });
    const { texts, post } = recorder();

    const sweep = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(sweep.crisisUnanswered.posted).toBe(1);
    expect(texts).toEqual([
      `Hale: URGENT crisis flagged, no reply sent. kind unreadable. where unreadable. reason unreadable. writes 0. ref ${claim?.id}.`,
    ]);
    // Named by the claim row's own id, so ops can find it; never by what it holds.
    expect(error).toHaveBeenCalledWith(
      { outcome: 'unreadable', claimId: claim?.id },
      'failure page: crisis claim unreadable - paging it as is',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('not-a-crisis-key');
    const again = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(again.crisisUnanswered.posted).toBe(0);
    expect(texts).toHaveLength(1);
  });

  it('the alert drops a phone-shaped or worded field rather than carry it', () => {
    const text = composeCrisisUnansweredAlert({
      kind: 'mental',
      where: PHONE_SHAPED,
      reason: PARENT_WORDS,
      writes: 2,
      ref: PHONE_SHAPED,
    });
    expect(text).toContain('where redacted');
    // The reference is a claim id or nothing: a non-uuid never rides along.
    expect(text).toContain('ref none.');
    expect(text).not.toContain(PHONE_SHAPED);
    expect(text).not.toContain(PARENT_WORDS);
    assertNoParentPayload(text);
  });
});

describe('VIL-553 · held opt-out reads page #ops by count', () => {
  let db: TestDb;
  const HOUR = 3_600_000;
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function held(providerMessageId: string, phoneHash: string, heldAt: Date) {
    await db.database
      .insert(schema.optOutHeldMessages)
      .values({ providerMessageId, phoneHash, heldAt, nextReadAt: heldAt });
  }

  async function seedThree(): Promise<void> {
    const family = await seedFamily(db.database, 'Held');
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'pm-ledger',
      status: 'delivered',
      body: PARENT_WORDS,
      sentAt: ago(HOUR / 2),
    });
    await held('pm-ledger', 'hash-x', ago(HOUR / 2));
    await held('pm-lost', 'hash-y', ago(3 * HOUR));
    await db.database
      .insert(schema.optOutReadHolds)
      .values({ phoneHash: 'hash-z', heldAt: ago(5 * HOUR) });
  }

  it('composes counts only, and renders a non-count as 0', () => {
    expect(
      composeOptOutHoldAlert({
        messages: 2,
        numbers: 3,
        notInLedger: 1,
        legacy: 1,
        oldestHours: Number.NaN,
      }),
    ).toBe(
      'Hale: opt-out reads held. messages 2. numbers 3. not in ledger 1. legacy 1. oldest 0h.',
    );
  });

  it('posts once an hour while a hold is new, with no hash, id or words', async () => {
    await seedThree();
    const { texts, post } = recorder();

    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const again = await pageFailureAlerts(db.database, {
      post,
      now: new Date(NOW.getTime() + 20 * 60_000),
    });

    expect(first.optOutHolds).toEqual({ posted: 1, deduped: 0, failed: 0 });
    expect(again.optOutHolds).toEqual({ posted: 0, deduped: 1, failed: 0 });
    expect(texts).toEqual([
      'Hale: opt-out reads held. messages 2. numbers 3. not in ledger 1. legacy 1. oldest 5h.',
    ]);
    for (const secret of ['hash-x', 'hash-y', 'hash-z', 'pm-ledger', 'pm-lost']) {
      expect(texts[0]).not.toContain(secret);
    }
    assertNoParentPayload(texts[0] ?? '');
    // Positive control: the stored hash is really there to leak.
    const rows = await db.database
      .select({ phoneHash: schema.optOutHeldMessages.phoneHash })
      .from(schema.optOutHeldMessages);
    expect(rows.map((row) => row.phoneHash)).toContain('hash-x');
  });

  it('a standing hold pages once a UTC day, not every hour', async () => {
    await held('pm-old', 'hash-y', ago(3 * HOUR));
    const { texts, post } = recorder();

    const first = await pageFailureAlerts(db.database, { post, now: NOW });
    const later = await pageFailureAlerts(db.database, {
      post,
      now: new Date(NOW.getTime() + 2 * HOUR),
    });
    const nextDay = await pageFailureAlerts(db.database, {
      post,
      now: new Date(NOW.getTime() + 13 * HOUR),
    });

    expect(first.optOutHolds.posted).toBe(1);
    expect(later.optOutHolds).toEqual({ posted: 0, deduped: 1, failed: 0 });
    expect(nextDay.optOutHolds.posted).toBe(1);
    expect(texts[1]).toContain('oldest 16h.');
  });

  it('a retired late-crisis mark pages nothing and is gone once a day old', async () => {
    // Rows the pre-VIL-602 count wrote; nothing writes the route now.
    await db.database.insert(schema.rateLimits).values([
      {
        identifier: 'a'.repeat(32),
        route: OPT_OUT_LATE_CRISIS_ROUTE,
        windowStart: ago(10 * 60_000),
        count: 1,
      },
      {
        identifier: 'b'.repeat(32),
        route: OPT_OUT_LATE_CRISIS_ROUTE,
        windowStart: ago(25 * HOUR),
        count: 1,
      },
    ]);
    const { texts, post } = recorder();

    await pageFailureAlerts(db.database, { post, now: NOW });

    expect(texts).toEqual([]);
    const marks = await db.database
      .select({ at: schema.rateLimits.windowStart })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, OPT_OUT_LATE_CRISIS_ROUTE));
    // Positive control: the fresh mark stands; only the day-old one was deleted.
    expect(marks.map((mark) => mark.at)).toEqual([ago(10 * 60_000)]);
  });

  it('posts nothing when nothing is held', async () => {
    const { texts, post } = recorder();
    const result = await pageFailureAlerts(db.database, { post, now: NOW });
    expect(result.optOutHolds).toEqual({ posted: 0, deduped: 0, failed: 0 });
    expect(texts).toEqual([]);
  });

  it("clears a crashed poster's claim so the next sweep pages", async () => {
    await held('pm-new', 'hash-x', ago(HOUR / 2));
    const hour = new Date(Math.floor(NOW.getTime() / HOUR) * HOUR);
    await db.database.insert(schema.rateLimits).values({
      identifier: 'new',
      route: OPT_OUT_HOLD_PAGE_ROUTE,
      windowStart: hour,
      count: claimStamp(ago(5 * 60_000)),
    });
    const { texts, post } = recorder();

    const result = await pageFailureAlerts(db.database, { post, now: NOW });

    expect(result.optOutHolds).toEqual({ posted: 1, deduped: 0, failed: 0 });
    expect(texts).toHaveLength(1);
  });
});
