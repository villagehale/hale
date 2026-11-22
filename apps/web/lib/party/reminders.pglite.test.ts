import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { scriptedGuestLineClient } from '~/lib/testing/party-guest-client';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type PartyGuestLine,
  type PartyGuestLineWriter,
  createPartyGuestLineWriter,
} from './guest-voice';
import {
  type PartyReminderDeps,
  defaultPartyReminderDeps,
  guestCancelDedupeKey,
  guestReminderDedupeKey,
  notifyGuestsOfCancellation,
  runPartyReminderCron,
} from './reminders';
import { cancelPartyInvite, optOutGuestRemindersOnStop, submitRsvp } from './store';

/**
 * VIL-745 · the two texts a party guest can get, both flag states, on the real queries:
 * the claim, the ledger row, the audit row and the opt-out are real. Only the provider
 * and the model are stand-ins. What the model writes is the eval's job (rule #8).
 */

const FLAG = 'PARTY_GUEST_MODEL_COPY_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
/** 10:10 in Toronto, inside the guest send hour. */
const NOW = new Date('2026-08-05T14:10:00Z');
/** 18:00 in Toronto, the next local day. */
const STARTS_AT = new Date('2026-08-06T22:00:00Z');
const TITLE = 'Birthday party for Nora';
const PLACE = '14 Elm St';
const PHONE_A = '416-555-0142';
const PHONE_A_E164 = '+14165550142';
const PHONE_B = '416-555-0143';
const PHONE_B_E164 = '+14165550143';

const FIXED_REMINDER =
  'Reminder from Hale: Birthday party for Nora is tomorrow - Thursday, August 6 at 6:00 PM at 14 Elm St. You asked me to remind you.';
const FIXED_CANCELLATION =
  'From Hale: Birthday party for Nora has been cancelled by the host. Sorry for the change.';
const WRITTEN_REMINDER =
  "It's Hale, with the reminder you asked for: Nora's birthday party is tomorrow, Thursday, August 6 at 6:00 PM at 14 Elm St.";
const WRITTEN_CANCELLATION =
  "It's Hale: the host has called off Nora's birthday party on Thursday, August 6. Sorry for the change.";

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv(FLAG, 'false');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

async function seedParty(input: { title?: string; location?: string | null } = {}) {
  const { familyId, parentUserId } = await seedFamily(db.database);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: input.title ?? TITLE,
      location: input.location === undefined ? PLACE : input.location,
      startsAt: STARTS_AT,
      source: 'party',
      createdBy: parentUserId,
    })
    .returning({ id: schema.familyEvents.id });
  const [invite] = await db.database
    .insert(schema.partyInvites)
    .values({
      familyId,
      familyEventId: event?.id as string,
      hostUserId: parentUserId,
      publicToken: `token-${familyId}`,
    })
    .returning({ id: schema.partyInvites.id });
  return {
    familyId,
    inviteId: invite?.id as string,
    familyEventId: event?.id as string,
    hostUserId: parentUserId,
  };
}

type SeededParty = Awaited<ReturnType<typeof seedParty>>;

function cancelParty(party: SeededParty) {
  return cancelPartyInvite(db.database, {
    familyId: party.familyId,
    inviteId: party.inviteId,
    familyEventId: party.familyEventId,
    actorUserId: party.hostUserId,
  });
}

async function addGuest(
  party: { familyId: string; inviteId: string },
  displayName: string,
  reminderPhone: string | null,
) {
  await submitRsvp(
    db.database,
    { inviteId: party.inviteId, familyId: party.familyId, cancelled: false },
    { displayName, response: 'yes', headcount: 1, reminderPhone },
    new Date('2026-08-01T00:00:00Z'),
  );
}

async function rsvps(inviteId: string) {
  return db.database
    .select({ id: schema.partyRsvps.id, reminderSentAt: schema.partyRsvps.reminderSentAt })
    .from(schema.partyRsvps)
    .where(eq(schema.partyRsvps.partyInviteId, inviteId));
}

async function ledgerKeys(familyId: string): Promise<string[]> {
  const rows = await db.database
    .select({ key: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
  return rows.map((row) => row.key as string).sort();
}

async function sendAudits(familyId: string): Promise<number> {
  const rows = await db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'party_guest_message_sent'),
      ),
    );
  return rows.length;
}

function recordingWriter(text: string) {
  const lines: PartyGuestLine[] = [];
  const writer: PartyGuestLineWriter = {
    async write(line) {
      lines.push(line);
      return { status: 'written', text };
    },
  };
  return { writer, lines };
}

const NEVER_WRITES: PartyGuestLineWriter = {
  async write() {
    throw new Error('the writer must not run with the flag off');
  },
};

function recordingPager() {
  const pages: OpsPage[] = [];
  const pager: OpsPager = {
    async page(page) {
      pages.push(page);
      return 'paged';
    },
  };
  return { pager, pages };
}

function depsWith(transport: FakeTransport, guestLine: PartyGuestLineWriter): PartyReminderDeps {
  return { ...defaultPartyReminderDeps(), transport, guestLine };
}

describe('flag off: both texts and every send path are today’s', () => {
  it('sends the fixed reminder, ledgers it under its dedupe key, and never runs the writer', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();

    const result = await runPartyReminderCron(db.database, depsWith(transport, NEVER_WRITES), NOW);

    expect(result).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: FIXED_REMINDER }]);
    const [guest] = await rsvps(party.inviteId);
    expect(guest?.reminderSentAt).not.toBeNull();
    expect(await ledgerKeys(party.familyId)).toEqual([guestReminderDedupeKey(guest?.id as string)]);
    expect(await sendAudits(party.familyId)).toBe(1);
  });

  it('sends the fixed cancellation and never runs the writer', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();

    const result = await notifyGuestsOfCancellation(
      db.database,
      { inviteId: party.inviteId },
      depsWith(transport, NEVER_WRITES),
      NOW,
    );

    expect(result).toEqual({ sent: 1, failed: 0, unwritten: 0, unpaged: 0 });
    expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: FIXED_CANCELLATION }]);
    const [guest] = await rsvps(party.inviteId);
    expect(await ledgerKeys(party.familyId)).toEqual([guestCancelDedupeKey(guest?.id as string)]);
  });

  it('takes no new check: a party cancelled mid-run still gets the send it gets today', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();
    const deps = depsWith(transport, NEVER_WRITES);
    const loadTeenNames = deps.loadTeenNames;
    deps.loadTeenNames = async (...args) => {
      await cancelParty(party);
      return loadTeenNames(...args);
    };

    await runPartyReminderCron(db.database, deps, NOW);

    expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: FIXED_REMINDER }]);
  });

  it('an inexact flag value is off', async () => {
    vi.stubEnv(FLAG, 'true\n');
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();

    await runPartyReminderCron(db.database, depsWith(transport, NEVER_WRITES), NOW);

    expect(transport.bodies()).toEqual([FIXED_REMINDER]);
  });
});

describe('flag on: the model writes the text, or nothing goes out', () => {
  beforeEach(() => {
    vi.stubEnv(FLAG, 'true');
  });

  it('sends the written reminder to every opted-in guest, on the same keys and claim', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    await addGuest(party, 'Sam', PHONE_B);
    await addGuest(party, 'Noor', null);
    const transport = new FakeTransport();
    const { writer, lines } = recordingWriter(WRITTEN_REMINDER);

    const result = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

    expect(result).toEqual({
      evaluated: 1,
      sent: 2,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(lines).toEqual([
      {
        why: 'asked_for_reminder',
        title: TITLE,
        when: 'Thursday, August 6 at 6:00 PM',
        where: PLACE,
      },
    ]);
    expect(transport.sent.map((s) => s.to).sort()).toEqual([PHONE_A_E164, PHONE_B_E164]);
    expect(new Set(transport.bodies())).toEqual(new Set([WRITTEN_REMINDER]));
    const rows = await rsvps(party.inviteId);
    const optedIn = rows.filter((row) => row.reminderSentAt !== null);
    expect(optedIn).toHaveLength(2);
    expect(await ledgerKeys(party.familyId)).toEqual(
      optedIn.map((row) => guestReminderDedupeKey(row.id)).sort(),
    );
    expect(await sendAudits(party.familyId)).toBe(2);
  });

  it('does not write or send a second time on a re-run', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();
    const { writer, lines } = recordingWriter(WRITTEN_REMINDER);

    await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);
    const again = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

    expect(again).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(lines).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('sends the written cancellation, on its own key, to a guest already reminded', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();
    await runPartyReminderCron(
      db.database,
      depsWith(transport, recordingWriter(WRITTEN_REMINDER).writer),
      NOW,
    );
    const { writer, lines } = recordingWriter(WRITTEN_CANCELLATION);

    const result = await notifyGuestsOfCancellation(
      db.database,
      { inviteId: party.inviteId },
      depsWith(transport, writer),
      NOW,
    );

    expect(result).toEqual({ sent: 1, failed: 0, unwritten: 0, unpaged: 0 });
    expect(lines).toEqual([
      {
        why: 'host_cancelled',
        title: TITLE,
        when: 'Thursday, August 6 at 6:00 PM',
        where: PLACE,
      },
    ]);
    expect(transport.bodies()).toEqual([WRITTEN_REMINDER, WRITTEN_CANCELLATION]);
    const [guest] = await rsvps(party.inviteId);
    expect(await ledgerKeys(party.familyId)).toEqual(
      [
        guestCancelDedupeKey(guest?.id as string),
        guestReminderDedupeKey(guest?.id as string),
      ].sort(),
    );
  });

  it('a reminder the model cannot write sends nothing, claims nothing, and pages once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    await addGuest(party, 'Sam', PHONE_B);
    const transport = new FakeTransport();
    const { pager, pages } = recordingPager();
    const failing = createPartyGuestLineWriter(() => {
      throw new Error('model outage');
    }, pager);

    const result = await runPartyReminderCron(db.database, depsWith(transport, failing), NOW);

    expect(result).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 0,
      unwritten: 2,
      unpaged: 0,
      superseded: 0,
    });
    expect(transport.sent).toEqual([]);
    expect(pages).toEqual([
      {
        site: 'party_guest_unwritten',
        facts: { why: 'asked_for_reminder', stage: 'after_retry' },
      },
    ]);
    expect((await rsvps(party.inviteId)).map((row) => row.reminderSentAt)).toEqual([null, null]);
    expect(await ledgerKeys(party.familyId)).toEqual([]);
    expect(await sendAudits(party.familyId)).toBe(0);

    // Positive control: nothing was burned, so a working writer in the same hour sends.
    const { writer } = recordingWriter(WRITTEN_REMINDER);
    const retried = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);
    expect(retried).toEqual({
      evaluated: 1,
      sent: 2,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(new Set(transport.bodies())).toEqual(new Set([WRITTEN_REMINDER]));
  });

  it('a cancellation the model cannot write sends nothing, names it, and pages once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    await addGuest(party, 'Sam', PHONE_B);
    const transport = new FakeTransport();
    const { pager, pages } = recordingPager();
    const failing = createPartyGuestLineWriter(() => {
      throw new Error('model outage');
    }, pager);

    const result = await notifyGuestsOfCancellation(
      db.database,
      { inviteId: party.inviteId },
      depsWith(transport, failing),
      NOW,
    );

    expect(result).toEqual({ sent: 0, failed: 0, unwritten: 2, unpaged: 0 });
    expect(transport.sent).toEqual([]);
    expect(pages).toEqual([
      { site: 'party_guest_unwritten', facts: { why: 'host_cancelled', stage: 'after_retry' } },
    ]);
    expect(await ledgerKeys(party.familyId)).toEqual([]);
  });

  it('names an unwritten text whose page did not leave, on both paths', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();
    const pager: OpsPager = { page: async () => 'page_not_configured' };
    const failing = createPartyGuestLineWriter(() => {
      throw new Error('model outage');
    }, pager);

    const reminder = await runPartyReminderCron(db.database, depsWith(transport, failing), NOW);
    const cancelled = await notifyGuestsOfCancellation(
      db.database,
      { inviteId: party.inviteId },
      depsWith(transport, failing),
      NOW,
    );

    expect(reminder).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 0,
      unwritten: 1,
      unpaged: 1,
      superseded: 0,
    });
    expect(cancelled).toEqual({ sent: 0, failed: 0, unwritten: 1, unpaged: 1 });
    expect(transport.sent).toEqual([]);
  });

  it('counts a provider failure after the text is written as failed and frees the claim', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    const { writer } = recordingWriter(WRITTEN_REMINDER);
    const transport = {
      async send(): Promise<{ providerMessageId: string }> {
        throw new Error('provider unreachable');
      },
    };

    const result = await runPartyReminderCron(
      db.database,
      { ...defaultPartyReminderDeps(), transport, guestLine: writer },
      NOW,
    );

    expect(result).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 1,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect((await rsvps(party.inviteId)).map((row) => row.reminderSentAt)).toEqual([null]);
    expect(await ledgerKeys(party.familyId)).toEqual([]);
  });

  it('redacts a teen before the prompt, and the prompt holds no guest detail', async () => {
    const party = await seedParty({
      title: "Tamsin and Pip's birthday",
      location: "Tamsin's house",
    });
    await db.database.insert(schema.children).values([
      { familyId: party.familyId, name: 'Tamsin', dateOfBirth: '2010-02-01' },
      { familyId: party.familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
    ]);
    await addGuest(party, 'Priya', PHONE_A);
    const transport = new FakeTransport();
    const { pager } = recordingPager();
    const reply =
      "It's Hale, with the reminder you asked for: the guest of honour and Pip's birthday is tomorrow at 6:00 PM at the guest of honour's house.";
    const { client, requests } = scriptedGuestLineClient([reply]);
    const writer = createPartyGuestLineWriter(() => client, pager);

    const result = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

    expect(result.sent).toBe(1);
    const prompt = JSON.stringify(requests);
    expect(prompt).toContain("the guest of honour and Pip's birthday");
    expect(prompt).toContain("the guest of honour's house");
    expect(prompt).not.toContain('Tamsin');
    expect(prompt).not.toContain('Priya');
    expect(prompt).not.toContain(PHONE_A);
    expect(prompt).not.toContain(PHONE_A_E164);
    expect(transport.bodies()).toEqual([reply]);
  });

  it('hands the writer a title and place with no number to text back', async () => {
    const party = await seedParty({
      title: 'Text WIN to 55555',
      location: 'Hall, Austin, TX 78701',
    });
    await addGuest(party, 'Priya', PHONE_A);
    const seen: PartyGuestLine[] = [];
    const writer: PartyGuestLineWriter = {
      async write(line) {
        seen.push(line);
        return { status: 'written', text: 'Hale here.' };
      },
    };

    await runPartyReminderCron(db.database, depsWith(new FakeTransport(), writer), NOW);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ title: 'Text WIN to', where: 'Hall, Austin, TX' });
  });

  it('does not text a guest who opts out while the model is writing', async () => {
    const party = await seedParty();
    await addGuest(party, 'Priya', PHONE_A);
    await addGuest(party, 'Sam', PHONE_B);
    const transport = new FakeTransport();
    const writer: PartyGuestLineWriter = {
      async write() {
        await optOutGuestRemindersOnStop(db.database, PHONE_A_E164, NOW);
        return { status: 'written', text: WRITTEN_REMINDER };
      },
    };

    const result = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

    expect(result).toEqual({
      evaluated: 1,
      sent: 1,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(transport.sent).toEqual([{ to: PHONE_B_E164, body: WRITTEN_REMINDER }]);
  });

  it('spends no model call on a party with nobody to text', async () => {
    const party = await seedParty();
    await addGuest(party, 'Noor', null);
    const transport = new FakeTransport();
    const { writer, lines } = recordingWriter(WRITTEN_REMINDER);

    const reminder = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);
    const cancelled = await notifyGuestsOfCancellation(
      db.database,
      { inviteId: party.inviteId },
      depsWith(transport, writer),
      NOW,
    );

    expect(reminder).toEqual({
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
      superseded: 0,
    });
    expect(cancelled).toEqual({ sent: 0, failed: 0, unwritten: 0, unpaged: 0 });
    expect(lines).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  describe('the party changes while the model writes', () => {
    const NOTHING_SENT = {
      evaluated: 1,
      sent: 0,
      deduped: 0,
      failed: 0,
      unwritten: 0,
      unpaged: 0,
    };

    function editEvent(
      party: SeededParty,
      change: Partial<typeof schema.familyEvents.$inferInsert>,
    ) {
      return db.database
        .update(schema.familyEvents)
        .set(change)
        .where(eq(schema.familyEvents.id, party.familyEventId));
    }

    it('sends no reminder for a party cancelled during the write', async () => {
      const party = await seedParty();
      await addGuest(party, 'Priya', PHONE_A);
      await addGuest(party, 'Sam', PHONE_B);
      const transport = new FakeTransport();
      const writer: PartyGuestLineWriter = {
        async write() {
          await cancelParty(party);
          return { status: 'written', text: WRITTEN_REMINDER };
        },
      };

      const result = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

      expect(result).toEqual({ ...NOTHING_SENT, superseded: 2 });
      expect(transport.sent).toEqual([]);
      expect((await rsvps(party.inviteId)).map((row) => row.reminderSentAt)).toEqual([null, null]);
      expect(await ledgerKeys(party.familyId)).toEqual([]);
    });

    it('does not take the claim for a party cancelled just before it', async () => {
      const party = await seedParty();
      await addGuest(party, 'Priya', PHONE_A);
      const transport = new FakeTransport();
      const { writer } = recordingWriter(WRITTEN_REMINDER);
      const deps = depsWith(transport, writer);
      const claim = deps.claim;
      deps.claim = async (...args) => {
        await cancelParty(party);
        return claim(...args);
      };

      const result = await runPartyReminderCron(db.database, deps, NOW);

      expect(result).toEqual({ ...NOTHING_SENT, superseded: 1 });
      expect(transport.sent).toEqual([]);
      expect((await rsvps(party.inviteId)).map((row) => row.reminderSentAt)).toEqual([null]);
    });

    const MOVED_TO = new Date('2026-08-06T23:30:00Z');
    it.each([
      ['time', { startsAt: MOVED_TO }, { when: 'Thursday, August 6 at 7:30 PM' }],
      ['place', { location: '99 Oak Ave' }, { where: '99 Oak Ave' }],
      ['title', { title: 'Pool party for Nora' }, { title: 'Pool party for Nora' }],
    ])(
      'discards a draft whose %s moved, and the next run writes the new one',
      async (_name, change, fact) => {
        const party = await seedParty();
        await addGuest(party, 'Priya', PHONE_A);
        const transport = new FakeTransport();
        const lines: PartyGuestLine[] = [];
        const fresh = `${WRITTEN_REMINDER} (fresh)`;
        const writer: PartyGuestLineWriter = {
          async write(line) {
            lines.push(line);
            if (lines.length > 1) return { status: 'written', text: fresh };
            await editEvent(party, change);
            return { status: 'written', text: WRITTEN_REMINDER };
          },
        };

        const first = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

        expect(first).toEqual({ ...NOTHING_SENT, superseded: 1 });
        expect(transport.sent).toEqual([]);
        expect((await rsvps(party.inviteId)).map((row) => row.reminderSentAt)).toEqual([null]);

        await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

        expect(lines[1]).toMatchObject(fact);
        expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: fresh }]);
      },
    );

    it('still sends when nothing the guest would read changed (positive control)', async () => {
      const party = await seedParty();
      await addGuest(party, 'Priya', PHONE_A);
      const transport = new FakeTransport();
      const writer: PartyGuestLineWriter = {
        async write() {
          await editEvent(party, { endsAt: new Date('2026-08-07T01:00:00Z') });
          return { status: 'written', text: WRITTEN_REMINDER };
        },
      };

      const result = await runPartyReminderCron(db.database, depsWith(transport, writer), NOW);

      expect(result).toEqual({ ...NOTHING_SENT, sent: 1, superseded: 0 });
      expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: WRITTEN_REMINDER }]);
    });

    it('still sends the cancellation note for a cancelled party', async () => {
      const party = await seedParty();
      await addGuest(party, 'Priya', PHONE_A);
      await cancelParty(party);
      const transport = new FakeTransport();
      const { writer } = recordingWriter(WRITTEN_CANCELLATION);

      const result = await notifyGuestsOfCancellation(
        db.database,
        { inviteId: party.inviteId },
        depsWith(transport, writer),
        NOW,
      );

      expect(result).toEqual({ sent: 1, failed: 0, unwritten: 0, unpaged: 0 });
      expect(transport.sent).toEqual([{ to: PHONE_A_E164, body: WRITTEN_CANCELLATION }]);
    });
  });
});
