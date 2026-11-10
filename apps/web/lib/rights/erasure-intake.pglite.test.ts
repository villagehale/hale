import { createHash } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, saveSession } from '~/lib/channel/intake/session';
import type { CrisisUnanswered } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  CRISIS_ANSWERED_ROUTE,
  CRISIS_UNANSWERED_PAGE_ROUTE,
  claimCrisisReply,
  failurePageCrisisPager,
} from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { runDeletionSweep } from './delete';
import { INTAKE_CONTENT_REDACTED } from './message-retention';

/**
 * VIL-636 · an erasure reaches what the parent texted before the family existed: the
 * intake sessions on their number with no family yet, and the crisis marks keyed by those
 * texts, which no ledger row names. Against the real DDL, through the sweep itself.
 */

/** The decoder's own fault, switched on per test: a bug in it is not a corrupt row. */
const decoder = vi.hoisted(() => ({ fault: null as Error | null }));
vi.mock('~/lib/channel/intake/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/channel/intake/session')>();
  return {
    ...actual,
    decodeIntakeForRecovery: (blob: string) => {
      if (decoder.fault) throw decoder.fault;
      return actual.decodeIntakeForRecovery(blob);
    },
  };
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-20T15:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60;
const PHONE_A = '+15555550101';
const PHONE_B = '+15555550102';
const WEBHOOK = 'https://hooks.example.test/ops';
const TEXT = 'she swallowed the pills';

let db: TestDb;
let posted: string[] = [];

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
  posted = [];
  decoder.fault = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec(
    'truncate table opt_out_held_messages, opt_out_read_holds, channel_messages, parent_channels, audit_log, sms_intake_sessions, rate_limits, family_members, families, users cascade',
  );
});

const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);
const keyOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

type Owner = { familyId: string; parentUserId: string };

async function channel(owner: Owner, phone: string, revokedAt: Date | null): Promise<void> {
  await db.database.insert(schema.parentChannels).values({
    userId: owner.parentUserId,
    familyId: owner.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: ago(30 * DAY),
    revokedAt,
  });
}

/** An intake session on `phone` with one inbound text, opened and closed at the given times. */
async function intake(
  phone: string,
  providerId: string,
  at: Date,
  over: { closedAt?: Date; owner?: Owner } = {},
): Promise<string> {
  const session = await createSession(db.database, {
    phoneE164: phone,
    state: 'awaiting_details',
    sourceCode: null,
  });
  await saveSession(
    db.database,
    session,
    {
      transcript: [{ direction: 'in', body: TEXT, providerId, at: at.toISOString() }],
      lastProviderId: providerId,
      ...(over.closedAt ? { state: 'superseded' as const, closedAt: over.closedAt } : {}),
      ...(over.owner ? { familyId: over.owner.familyId, userId: over.owner.parentUserId } : {}),
    },
    over.closedAt ?? at,
  );
  await db.database
    .update(schema.smsIntakeSessions)
    .set({ createdAt: at })
    .where(eq(schema.smsIntakeSessions.id, session.id));
  return session.id;
}

async function session(id: string) {
  const [row] = await db.database
    .select({
      dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
      phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
      familyId: schema.smsIntakeSessions.familyId,
      closedAt: schema.smsIntakeSessions.closedAt,
    })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.id, id));
  return row ?? null;
}

async function corrupt(sessionId: string): Promise<void> {
  await db.database
    .update(schema.smsIntakeSessions)
    .set({ dataEncrypted: 'not-a-sealed-blob' })
    .where(eq(schema.smsIntakeSessions.id, sessionId));
}

async function hold(phone: string, providerMessageId: string, heldAt: Date): Promise<void> {
  await db.database.insert(schema.optOutHeldMessages).values({
    providerMessageId,
    phoneHash: phoneBlindIndex(phone),
    heldAt,
    nextReadAt: heldAt,
  });
}

async function ledgerText(owner: Owner, providerMessageId: string, sentAt: Date): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: owner.familyId,
    parentUserId: owner.parentUserId,
    channel: 'sms',
    direction: 'in',
    category: 'reply',
    providerMessageId,
    status: 'delivered',
    body: TEXT,
    sentAt,
  });
}

function crisis(inboundId: string, owner: Owner | null): CrisisUnanswered {
  return {
    kind: 'emergency',
    where: 'late read',
    reason: 'write_failed',
    writes: 2,
    inboundId,
    familyId: owner?.familyId ?? null,
    parentUserId: owner?.parentUserId ?? null,
    language: 'en',
    situation: 'poisoning_or_overdose',
    who: 'child',
  };
}

/** A crisis claim and a reply mark keyed by `inboundId`. */
async function crisisMarked(inboundId: string, owner: Owner | null): Promise<void> {
  await failurePageCrisisPager(db.database, { post: async () => 'sent' }).record(
    crisis(inboundId, owner),
  );
  expect(await claimCrisisReply(db.database, inboundId, ago(5))).toBe('claimed');
}

async function crisisKeys(): Promise<string[]> {
  const rows = await db.database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(inArray(schema.rateLimits.route, [CRISIS_UNANSWERED_PAGE_ROUTE, CRISIS_ANSWERED_ROUTE]));
  return rows.map((row) => row.identifier.split(':')[0] as string).sort();
}

async function erase(familyId: string) {
  await db.database
    .update(schema.families)
    .set({ scheduledDeletionAt: ago(1) })
    .where(eq(schema.families.id, familyId));
  return runDeletionSweep(db.database, NOW, async () => {});
}

describe('erasure · the pre-signup intake of the erased parent', () => {
  it("redacts the parent's older pre-signup session in the same sweep, and never the next holder's", async () => {
    const erased = await seedFamily(db.database, 'First Family');
    await channel(erased, PHONE_A, ago(DAY));
    const presignup = await intake(PHONE_A, 'pm-presignup', ago(40 * DAY), {
      closedAt: ago(39 * DAY),
    });
    // The number's next holder, mid-intake after the family let it go.
    const nextHolder = await intake(PHONE_A, 'pm-next-holder', ago(30));
    // No held text anywhere: the redaction is the erasure's, not the hold's.
    expect(await db.database.select().from(schema.optOutHeldMessages)).toEqual([]);

    const summary = await erase(erased.familyId);

    expect(summary.erased).toBe(1);
    expect(await session(presignup)).toMatchObject({
      dataEncrypted: INTAKE_CONTENT_REDACTED,
      phoneEncrypted: INTAKE_CONTENT_REDACTED,
      familyId: null,
      closedAt: ago(39 * DAY),
    });
    // Positive control: the session opened after the family let the number go is not theirs.
    const kept = await session(nextHolder);
    expect(kept?.dataEncrypted).not.toBe(INTAKE_CONTENT_REDACTED);
    expect(kept?.phoneEncrypted).not.toBe(INTAKE_CONTENT_REDACTED);
    expect(kept?.closedAt).toBeNull();
  }, 30_000);

  it("takes the crisis claim of a pre-signup text; another family's and the next holder's stay", async () => {
    const erased = await seedFamily(db.database, 'First Family');
    await channel(erased, PHONE_A, ago(DAY));
    await intake(PHONE_A, 'pm-presignup', ago(40 * DAY), { closedAt: ago(39 * DAY) });
    await crisisMarked('pm-presignup', null);
    await intake(PHONE_A, 'pm-next-holder', ago(30));
    await crisisMarked('pm-next-holder', null);
    const other = await seedFamily(db.database, 'Second Family');
    await channel(other, PHONE_B, null);
    await ledgerText(other, 'pm-other', ago(20));
    await crisisMarked('pm-other', other);
    expect(await crisisKeys()).toHaveLength(6);

    expect((await erase(erased.familyId)).erased).toBe(1);

    expect(await crisisKeys()).toEqual(
      [
        keyOf('pm-next-holder'),
        keyOf('pm-next-holder'),
        keyOf('pm-other'),
        keyOf('pm-other'),
      ].sort(),
    );
  }, 30_000);
});

describe('erasure · an intake session that will not decode', () => {
  it('pages with the session as its reference, and keeps that session row redacted to resolve it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const erased = await seedFamily(db.database, 'First Family');
    await channel(erased, PHONE_A, ago(DAY));
    const unreadable = await intake(PHONE_A, 'pm-unreadable', ago(31 * DAY), {
      owner: erased,
      closedAt: ago(30 * DAY),
    });
    await corrupt(unreadable);
    const holder = await seedFamily(db.database, 'Second Family');
    await channel(holder, PHONE_A, null);
    await hold(PHONE_A, 'pm-holder-own', ago(20));

    const summary = await erase(erased.familyId);

    expect(summary.erased).toBe(1);
    expect(summary.undecodableIntake).toEqual({ sessions: 1, page: 'paged' });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('erasure_intake_undecodable');
    expect(posted[0]).toContain(`ref ${unreadable}.`);
    // What ops resolves the reference from: the number's hash, and none of the content.
    expect(await session(unreadable)).toMatchObject({
      dataEncrypted: INTAKE_CONTENT_REDACTED,
      phoneEncrypted: INTAKE_CONTENT_REDACTED,
      familyId: null,
    });
  }, 30_000);

  it('a fault in the decoder is not counted as undecodable: it stops the sweep, and the cron pages', async () => {
    const erased = await seedFamily(db.database, 'First Family');
    await channel(erased, PHONE_A, ago(DAY));
    await intake(PHONE_A, 'pm-presignup', ago(40 * DAY), { closedAt: ago(39 * DAY) });
    await hold(PHONE_A, 'pm-presignup', ago(40 * DAY));
    decoder.fault = new TypeError("Cannot read properties of undefined (reading 'flatMap')");

    await expect(erase(erased.familyId)).rejects.toThrow(TypeError);

    // Nothing was taken on a guess: the family stands for the next sweep, and no
    // undecodable page claimed the fault as a corrupt row.
    expect(await db.database.select({ id: schema.families.id }).from(schema.families)).toEqual([
      { id: erased.familyId },
    ]);
    expect(posted).toEqual([]);
  }, 30_000);
});
