import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { seedCanaryHousehold } from '~/lib/channel/canary/seed';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { TURN_DEFERRED_ACTION, TURN_FAILED_ACTION } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  DEAD_LETTER_PAGE_ROUTE,
  DEFERRED_PILEUP_PAGE_ROUTE,
  DEFERRED_PILEUP_THRESHOLD,
  FIRST_HELLO_PAGE_ROUTE,
  MODEL_PROVIDER,
  PROVIDER_INCIDENT_PAGE_ROUTE,
  TURN_DEFERRED_AUDIT_ACTION,
  TURN_FAILED_AUDIT_ACTION,
  TURN_FAILURE_PAGE_ROUTE,
  composeDeadLetterAlert,
  composeDeferredPileupAlert,
  composeFirstHelloFailureAlert,
  composeProviderIncidentAlert,
  composeTurnFailureAlert,
  failureCategory,
  firstHelloFailureCategory,
  noteDeadLetteredTurn,
  noteFirstHelloFailure,
  pageFailureAlerts,
} from './failure-page';

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
    over: { providerFailure?: 'billing' | 'auth'; targetId?: string; occurredAt?: Date } = {},
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
