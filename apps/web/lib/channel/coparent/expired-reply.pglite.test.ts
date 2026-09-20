import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAPSED_REPLY_WINDOW_MS,
  declineOpenInviteOnStop,
  loadLapsedInviteByPhone,
  loadOpenInviteByPhone,
  loadPendingAssent,
  recordCoParentAssent,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import { handleLapsedInviteReply } from '~/lib/channel/caregiver/route';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { INVITE_EXPIRED_BY_LANGUAGE } from './copy';

/**
 * VIL-355 follow-up · item 1 — the YES that arrives on day four.
 *
 * Before this, the 72h sweep closed the row on READ and answered null, so the late
 * affirmative fell through every branch and landed on `greet`: the stranger Hale had
 * texted once was answered with an intake greeting and asked for their children's names.
 * Against the real DDL because the whole thing is a state read — a fake hands back the
 * rows it was given and would pass with the state filter deleted.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const NOW = new Date('2026-09-15T12:00:00.000Z');
/** The parent's YES, so the invitee is the one being waited on. */
const ASKED = new Date(NOW.getTime() + 60_000);
/** 73h after the invitee was asked: one hour past the silence bound. */
const LATE = new Date(ASKED.getTime() + 73 * 3_600_000);

let db: TestDb;
let households = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(): Promise<{ familyId: string; parentUserId: string }> {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:household-${households}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

/** An invite that reached the stranger's phone and was never answered. */
async function seedAskedInvite(seeded: { familyId: string; parentUserId: string }) {
  const started = await startCoParentInvite(db.database, {
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    inviterPhoneE164: PARENT_PHONE,
    inviterName: 'Ana',
    parsed: { ok: true, name: 'Sam', phoneE164: PARTNER_PHONE, role: 'co_parent' },
    language: 'en',
    now: NOW,
  });
  if (started.status !== 'started') throw new Error(`seed failed: ${JSON.stringify(started)}`);
  const pending = await loadPendingAssent(db.database, seeded.parentUserId, ASKED);
  if (pending?.role !== 'co_parent') throw new Error('seed: no pending co-parent assent');
  await recordCoParentAssent(db.database, {
    invite: pending,
    inviterName: 'Ana',
    language: 'en',
    verbatimReply: 'yes',
    channelMessageId: null,
    now: ASKED,
  });
  return pending;
}

function deps(transport: FakeTransport) {
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  const openQuestions = vi.fn(async () => []);
  return {
    threaded,
    openQuestions,
    deps: {
      transport,
      threadMessage: async (
        _db: unknown,
        input: { familyId: string; parentUserId: string; body: string },
      ) => {
        threaded.push(input);
        return 'conv-1';
      },
      openQuestions,
    },
  };
}

async function auditVerbs(): Promise<string[]> {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog);
  return rows.map((r) => r.actionTaken);
}

describe('a late answer to an invitation that has lapsed', () => {
  it('is found after the expiry sweep has already closed the row', async () => {
    const seeded = await seedFamily();
    await seedAskedInvite(seeded);

    // The read that makes the sweep happen — and answers null, which is what used to
    // send the stranger to `greet`.
    expect(await loadOpenInviteByPhone(db.database, PARTNER_PHONE, LATE)).toBeNull();
    const lapsed = await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, LATE);
    expect(lapsed).toMatchObject({ role: 'co_parent', state: 'expired', familyId: seeded.familyId });
  });

  it('answers with one honest sentence, seats nobody, and records the outcome', async () => {
    const seeded = await seedFamily();
    await seedAskedInvite(seeded);
    await loadOpenInviteByPhone(db.database, PARTNER_PHONE, LATE);
    const lapsed = await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, LATE);
    if (!lapsed) throw new Error('expected a lapsed invite');
    const transport = new FakeTransport();
    const { deps: replyDeps, threaded, openQuestions } = deps(transport);

    const outcome = await handleLapsedInviteReply(
      db.database,
      {
        invite: lapsed,
        phoneE164: PARTNER_PHONE,
        inbound: { providerId: 'SM-late', body: 'YES', from: PARTNER_PHONE, receivedAt: LATE },
        now: LATE,
      },
      replyDeps,
    );

    expect(outcome).toEqual({ status: 'invite_expired_answered', role: 'co_parent' });
    expect(transport.sent).toEqual([
      { to: PARTNER_PHONE, body: INVITE_EXPIRED_BY_LANGUAGE.en },
    ]);
    // Not the inviting parent's conversation — a third party's answer is never threaded.
    expect(threaded).toEqual([]);
    // No seat, and the invite is left expired rather than reopened.
    const seats = await db.database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, seeded.familyId));
    expect(seats).toHaveLength(1);
    const [invite] = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites);
    expect(invite?.state).toBe('expired');
    // Rule #6: the answer is a named outcome on the invite, not just an outbound row.
    expect(await auditVerbs()).toContain('co_parent_invite_expired_answered');
    // THE CONSTRAINT: this YES belongs to the invitation and to nothing else. The lapsed
    // reply never opens the open-question reader, so it cannot consume an answer one of
    // the other eleven kinds is waiting for. (Above it, the machine only reaches this
    // branch for a number with no channel at all — a stranger has no open questions.)
    expect(openQuestions).not.toHaveBeenCalled();
  });

  it('answers a French late yes in French', async () => {
    const seeded = await seedFamily();
    await seedAskedInvite(seeded);
    await loadOpenInviteByPhone(db.database, PARTNER_PHONE, LATE);
    const lapsed = await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, LATE);
    if (!lapsed) throw new Error('expected a lapsed invite');
    const transport = new FakeTransport();

    await handleLapsedInviteReply(
      db.database,
      {
        invite: lapsed,
        phoneE164: PARTNER_PHONE,
        inbound: { providerId: 'SM-late-fr', body: 'oui merci', from: PARTNER_PHONE, receivedAt: LATE },
        now: LATE,
      },
      deps(transport).deps,
    );

    expect(transport.sent[0]?.body).toBe(INVITE_EXPIRED_BY_LANGUAGE.fr);
  });

  it('says nothing to a number that pressed STOP, and still answers one that did not', async () => {
    // The absence assertion's positive control: the same seed, one STOP apart.
    const stopped = await seedFamily();
    await seedAskedInvite(stopped);
    expect(await declineOpenInviteOnStop(db.database, PARTNER_PHONE, LATE)).toBe(true);
    expect(await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, LATE)).toBeNull();

    await db.exec('truncate table families, users cascade');
    const silent = await seedFamily();
    await seedAskedInvite(silent);
    await loadOpenInviteByPhone(db.database, PARTNER_PHONE, LATE);
    expect(await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, LATE)).not.toBeNull();
  });

  it('stops answering once the lapse is stale, so a stranger can start their own intake', async () => {
    const seeded = await seedFamily();
    await seedAskedInvite(seeded);
    const staleAt = new Date(LATE.getTime() + LAPSED_REPLY_WINDOW_MS + 60_000);
    await loadOpenInviteByPhone(db.database, PARTNER_PHONE, staleAt);

    expect(await loadLapsedInviteByPhone(db.database, PARTNER_PHONE, staleAt)).toBeNull();
  });
});

describe("the parent's own re-issue after a lapse (already true on HEAD — pinned, not built)", () => {
  it('opens a fresh invite to the same number with the same phrase', async () => {
    const seeded = await seedFamily();
    await seedAskedInvite(seeded);
    await loadOpenInviteByPhone(db.database, PARTNER_PHONE, LATE);

    const again = await startCoParentInvite(db.database, {
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      inviterPhoneE164: PARENT_PHONE,
      inviterName: 'Ana',
      parsed: { ok: true, name: 'Sam', phoneE164: PARTNER_PHONE, role: 'co_parent' },
      language: 'en',
      now: new Date(LATE.getTime() + 3_600_000),
    });

    expect(again.status).toBe('started');
    const states = await db.database
      .select({ state: schema.caregiverInvites.state })
      .from(schema.caregiverInvites);
    expect(states.map((r) => r.state).sort()).toEqual(['awaiting_parent_assent', 'expired']);
  });
});
