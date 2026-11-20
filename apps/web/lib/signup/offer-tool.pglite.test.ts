import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { holdSender, releaseHeldMessage } from '~/lib/channel/intake/opt-out-hold';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { type RecordedSignupOffer, offerSignupTool } from './offer-tool';
import {
  type SignupSupersedeReader,
  type SupersedeReadInput,
  toSupersedeReading,
} from './supersede-reader';
import { echoOfferWriter } from './test-models';

const NOW = new Date('2026-10-28T15:00:00.000Z');
const URL = 'https://harbor-rec.example/register';

describe('offer_signup coach verb', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('records an offer from chat facts the parent already wrote', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const writer = echoOfferWriter();
    const recorded: RecordedSignupOffer[] = [];
    const tool = offerSignupTool({
      database: db.database,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: NOW,
      parentWords: `Ada's rec email has parent and tot swim Tuesday 4:30 at ${URL}`,
      optOutUnread: false,
      linksThisTurn: () => [],
      writer,
      onRecorded: (offer) => recorded.push(offer),
    });
    const result = (await invokeTool(
      tool,
      {
        child: 'Ada',
        activity: 'Parent and Tot Swim',
        source: 'chat',
        registrationUrl: URL,
        evidence: 'parent and tot swim Tuesday 4:30',
        sessions: [
          {
            id: 'tue-1630',
            label: 'Tue 4:30',
            startsAt: '2026-11-03T20:30:00.000Z',
            endsAt: '2026-11-03T21:15:00.000Z',
            full: false,
            priceCents: 4000,
          },
        ],
        approvedPriceCents: 4000,
      },
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      { writeAudit: async () => {} },
    )) as { recorded: boolean; offerId?: string; text?: string };

    expect(result.recorded).toBe(true);
    expect(result.text).toContain('Tue 4:30');
    const rows = await db.database
      .select({
        id: schema.authorizedSignupOffers.id,
        status: schema.authorizedSignupOffers.status,
        lastAskedSeq: schema.authorizedSignupOffers.lastAskedSeq,
      })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, seeded.familyId));
    // Recorded, not yet asked: the router stamps it once the reply carrying the text went out.
    expect(rows).toEqual([{ id: result.offerId, status: 'pending', lastAskedSeq: null }]);
    expect(recorded).toEqual([{ offerId: result.offerId, text: result.text }]);
  });

  const GYM_URL = 'https://gym.example-rec.test/register/tots';
  const KICKERS_URL = 'https://kickers.example-sport.test/register/sat';

  /**
   * Stands in for the supersede model: it drops the asks whose label `drops` names. The
   * model itself is the signup-offer-supersede eval's subject.
   */
  function supersedeReader(drops: string | null): SignupSupersedeReader {
    return {
      read: vi.fn(async ({ earlier }: SupersedeReadInput) => ({
        replaced: earlier.filter((ask) => ask.activity === drops).map((ask) => ask.offerId),
        unnamed: [],
      })),
    };
  }

  function ask(
    f: { familyId: string; parentUserId: string },
    url: string,
    activity: string,
    label: string,
    at: Date,
    reader: SignupSupersedeReader,
    words = `${activity} ${label} ${url}`,
    optOutUnread = false,
  ) {
    return invokeTool(
      offerSignupTool({
        database: db.database,
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        now: at,
        parentWords: words,
        optOutUnread,
        linksThisTurn: () => [],
        writer: echoOfferWriter(),
        supersedeReader: reader,
        onRecorded: () => {},
      }),
      {
        child: 'Ada',
        activity,
        source: 'chat',
        registrationUrl: url,
        evidence: `${activity} ${label}`,
        sessions: [
          {
            id: 'sat-session',
            label,
            startsAt: '2027-01-09T15:15:00.000Z',
            endsAt: '2027-01-09T16:00:00.000Z',
            full: false,
            priceCents: 12000,
          },
        ],
        approvedPriceCents: null,
      },
      { familyId: f.familyId, actor: f.parentUserId },
      { writeAudit: async () => {} },
    ) as Promise<{ recorded: boolean; reason?: string; replaced?: unknown[] }>;
  }

  async function asks(familyId: string) {
    return db.database
      .select({
        label: schema.authorizedSignupOffers.activityLabel,
        status: schema.authorizedSignupOffers.status,
      })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.familyId, familyId));
  }

  async function seedCoParent(familyId: string): Promise<string> {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `co-${familyId}@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('seedCoParent: users insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: user.id, role: 'co_parent' });
    return user.id;
  }

  it('a new ask the parent added beside the earlier one leaves both open', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const first = await ask(
      seeded,
      GYM_URL,
      'Gymnastics Tots',
      'Sat 10:15',
      NOW,
      supersedeReader(null),
    );
    expect(first).toMatchObject({ recorded: true, replaced: [] });
    const reader = supersedeReader(null);
    const second = await ask(
      seeded,
      KICKERS_URL,
      'Little Kickers',
      'Sat 9:30',
      new Date(NOW.getTime() + 60_000),
      reader,
    );
    expect(second).toMatchObject({ recorded: true, replaced: [] });
    expect(vi.mocked(reader.read).mock.calls[0]?.[0]).toMatchObject({
      next: { activity: 'Little Kickers', host: 'kickers.example-sport.test' },
      earlier: [
        { activity: 'Gymnastics Tots', host: 'gym.example-rec.test', sessionLabels: ['Sat 10:15'] },
      ],
    });
    expect(await asks(seeded.familyId)).toEqual(
      expect.arrayContaining([
        { label: 'Gymnastics Tots', status: 'pending' },
        { label: 'Little Kickers', status: 'pending' },
      ]),
    );
  });

  it('a new ask the parent switched to closes the earlier one and tells the coach', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
    const second = await ask(
      seeded,
      KICKERS_URL,
      'Little Kickers',
      'Sat 9:30',
      new Date(NOW.getTime() + 60_000),
      supersedeReader('Gymnastics Tots'),
    );
    expect(second).toMatchObject({
      recorded: true,
      replaced: [
        { activity: 'Gymnastics Tots', host: 'gym.example-rec.test', sessions: ['Sat 10:15'] },
      ],
    });
    expect(await asks(seeded.familyId)).toEqual(
      expect.arrayContaining([
        { label: 'Gymnastics Tots', status: 'handed_back' },
        { label: 'Little Kickers', status: 'pending' },
      ]),
    );
  });

  it('records and closes nothing on a turn whose text the opt-out read could not read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
    const reader = supersedeReader('Gymnastics Tots');
    const later = new Date(NOW.getTime() + 60_000);

    const unread = await ask(
      seeded,
      KICKERS_URL,
      'Little Kickers',
      'Sat 9:30',
      later,
      reader,
      undefined,
      true,
    );

    expect(unread).toEqual({ recorded: false, reason: 'opt_out_unread' });
    expect(reader.read).not.toHaveBeenCalled();
    expect(await asks(seeded.familyId)).toEqual([{ label: 'Gymnastics Tots', status: 'pending' }]);

    // Positive control: the same words on a turn the read could read switch the ask.
    const read = await ask(seeded, KICKERS_URL, 'Little Kickers', 'Sat 9:30', later, reader);
    expect(read).toMatchObject({ recorded: true });
    expect(await asks(seeded.familyId)).toEqual(
      expect.arrayContaining([
        { label: 'Gymnastics Tots', status: 'handed_back' },
        { label: 'Little Kickers', status: 'pending' },
      ]),
    );
  });

  it('records and closes nothing while an earlier text of the parent is held unread', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    const phone = '+14165550188';
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    await db.database.insert(schema.parentChannels).values({
      familyId: seeded.familyId,
      userId: seeded.parentUserId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: NOW,
    });
    await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
    await holdSender(db.database, {
      phoneHash: phoneBlindIndex(phone),
      providerMessageId: `held-${seeded.familyId}`,
      now: NOW,
    });
    const reader = supersedeReader('Gymnastics Tots');
    const later = new Date(NOW.getTime() + 60_000);

    const held = await ask(seeded, KICKERS_URL, 'Little Kickers', 'Sat 9:30', later, reader);

    expect(held).toEqual({ recorded: false, reason: 'opt_out_unread' });
    expect(await asks(seeded.familyId)).toEqual([{ label: 'Gymnastics Tots', status: 'pending' }]);
    // Once that text is read, the hold goes and the same words switch the ask.
    await releaseHeldMessage(db.database, `held-${seeded.familyId}`);
    expect(
      await ask(seeded, KICKERS_URL, 'Little Kickers', 'Sat 9:30', later, reader),
    ).toMatchObject({
      recorded: true,
    });
    vi.unstubAllEnvs();
  });

  it('an earlier ask the parent dropped in words that do not name it stays open beside the new one, and the coach is told', async () => {
    // The model's reading is stipulated, its worst: the earlier gymnastics ask dropped on the
    // words `said`. The check is the real one.
    async function switchToKickers(said: string, words: string) {
      const seeded = await seedFamily(db.database);
      await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
      await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
      const reader: SignupSupersedeReader = {
        read: vi.fn(async ({ earlier, text }: SupersedeReadInput) =>
          toSupersedeReading({ reason: 'r', replaced: [{ ref: 'ask-1', said }] }, earlier, text),
        ),
      };
      const result = await ask(
        seeded,
        KICKERS_URL,
        'Little Kickers',
        'Sat 9:30',
        new Date(NOW.getTime() + 60_000),
        reader,
        `${words} Little Kickers Sat 9:30 ${KICKERS_URL}`,
      );
      return { result, rows: await asks(seeded.familyId) };
    }

    const kept = await switchToKickers('体操那个不要了', '体操那个不要了，换');
    expect(kept.result).toMatchObject({
      recorded: true,
      replaced: [],
      keptOpen: [
        { activity: 'Gymnastics Tots', host: 'gym.example-rec.test', sessions: ['Sat 10:15'] },
      ],
    });
    expect(kept.rows).toEqual(
      expect.arrayContaining([
        { label: 'Gymnastics Tots', status: 'pending' },
        { label: 'Little Kickers', status: 'pending' },
      ]),
    );

    // Positive control: a drop in words that name it closes it.
    const closed = await switchToKickers('forget the gymnastics', 'forget the gymnastics,');
    expect(closed.result).toMatchObject({
      recorded: true,
      replaced: [{ activity: 'Gymnastics Tots' }],
    });
    expect(closed.result).not.toHaveProperty('keptOpen');
    expect(closed.rows).toEqual(
      expect.arrayContaining([{ label: 'Gymnastics Tots', status: 'handed_back' }]),
    );
  });

  it("the reader is shown only this parent's own asks, never the co-parent's", async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const coParentUserId = await seedCoParent(seeded.familyId);
    await ask(
      { ...seeded, parentUserId: coParentUserId },
      GYM_URL,
      'Gymnastics Tots',
      'Sat 10:15',
      NOW,
      supersedeReader(null),
    );
    const reader = supersedeReader('Gymnastics Tots');
    const mine = await ask(
      seeded,
      KICKERS_URL,
      'Little Kickers',
      'Sat 9:30',
      new Date(NOW.getTime() + 60_000),
      reader,
    );
    expect(mine).toMatchObject({ recorded: true, replaced: [] });
    // With no earlier ask of their own there is nothing to read.
    expect(reader.read).not.toHaveBeenCalled();
    expect(await asks(seeded.familyId)).toEqual(
      expect.arrayContaining([{ label: 'Gymnastics Tots', status: 'pending' }]),
    );
  });

  it('an unreadable supersede read stops: nothing is recorded and nothing closes', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
    const result = await ask(
      seeded,
      KICKERS_URL,
      'Little Kickers',
      'Sat 9:30',
      new Date(NOW.getTime() + 60_000),
      { read: async () => null },
    );
    expect(result).toEqual({ recorded: false, reason: 'supersede_unread' });
    expect(await asks(seeded.familyId)).toEqual([{ label: 'Gymnastics Tots', status: 'pending' }]);
  });

  describe('a group member who may not authorize a sign-up', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('creates and closes no ask, and the refusal is audited', async () => {
      vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
      const seeded = await seedFamily(db.database);
      await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
      await ask(seeded, GYM_URL, 'Gymnastics Tots', 'Sat 10:15', NOW, supersedeReader(null));
      const [caregiver] = await db.database
        .insert(schema.users)
        .values({ email: `care-${seeded.familyId}@example.test`, name: 'Care Giver' })
        .returning({ id: schema.users.id });
      if (!caregiver) throw new Error('no caregiver');
      await db.database.insert(schema.linqGroupMembers).values({
        familyId: seeded.familyId,
        chatId: 'chat-household',
        userId: caregiver.id,
        phoneE164Encrypted: 'invented-ciphertext',
        phoneE164Hash: `invented-hash-${caregiver.id}`,
        role: 'caregiver',
      });
      const reader = supersedeReader('Gymnastics Tots');
      const result = await ask(
        { familyId: seeded.familyId, parentUserId: caregiver.id },
        KICKERS_URL,
        'Little Kickers',
        'Sat 9:30',
        new Date(NOW.getTime() + 60_000),
        reader,
      );

      expect(result).toEqual({ recorded: false, reason: 'group_member_not_authorized' });
      expect(reader.read).not.toHaveBeenCalled();
      expect(await asks(seeded.familyId)).toEqual([
        { label: 'Gymnastics Tots', status: 'pending' },
      ]);
      const refusals = await db.database
        .select({ after: schema.auditLog.after })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.familyId, seeded.familyId),
            eq(schema.auditLog.actionTaken, 'linq_group_member_refused'),
          ),
        );
      expect(refusals).toEqual([{ after: { capability: 'signup' } }]);

      // Positive control: the parent, with no seat, still offers.
      const own = await ask(
        seeded,
        KICKERS_URL,
        'Little Kickers',
        'Sat 9:30',
        new Date(NOW.getTime() + 120_000),
        supersedeReader(null),
      );
      expect(own).toMatchObject({ recorded: true });
    });
  });

  it('refuses a URL the turn never saw', async () => {
    const seeded = await seedFamily(db.database);
    await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
    const tool = offerSignupTool({
      database: db.database,
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      now: NOW,
      parentWords: 'can you sign Ada up for swim',
      optOutUnread: false,
      linksThisTurn: () => [],
      writer: echoOfferWriter(),
      onRecorded: () => {},
    });
    const result = (await invokeTool(
      tool,
      {
        child: 'Ada',
        activity: 'Parent and Tot Swim',
        source: 'email',
        registrationUrl: URL,
        evidence: 'swim',
        sessions: [
          {
            id: 'tue-1630',
            label: 'Tue 4:30',
            startsAt: '2026-11-03T20:30:00.000Z',
            endsAt: '2026-11-03T21:15:00.000Z',
            full: false,
            priceCents: 4000,
          },
        ],
        approvedPriceCents: 4000,
      },
      { familyId: seeded.familyId, actor: seeded.parentUserId },
      { writeAudit: async () => {} },
    )) as { recorded: boolean; reason?: string };
    expect(result).toEqual({ recorded: false, reason: 'url_not_this_turn' });
  });

  describe('the program name an ask is stored, and named, by', () => {
    /** Records one email-sourced ask for the Kickers page; returns the label it was stored under. */
    async function storedLabel(input: {
      activity: string;
      words: string;
      links: { title: string; url: string }[];
    }) {
      const seeded = await seedFamily(db.database);
      await seedChild(db.database, seeded.familyId, 'Ada', 36, undefined, NOW);
      const result = await invokeTool(
        offerSignupTool({
          database: db.database,
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          now: NOW,
          parentWords: input.words,
          optOutUnread: false,
          linksThisTurn: () => input.links,
          writer: echoOfferWriter(),
          onRecorded: () => {},
        }),
        {
          child: 'Ada',
          activity: input.activity,
          source: 'email',
          registrationUrl: KICKERS_URL,
          evidence: 'Saturday 9:30 class',
          sessions: [
            {
              id: 'sat-session',
              label: 'Sat 9:30',
              startsAt: '2027-01-09T14:30:00.000Z',
              endsAt: '2027-01-09T15:15:00.000Z',
              full: false,
              priceCents: 12000,
            },
          ],
          approvedPriceCents: null,
        },
        { familyId: seeded.familyId, actor: seeded.parentUserId },
        { writeAudit: async () => {} },
      );
      expect(result).toMatchObject({ recorded: true });
      return (await asks(seeded.familyId)).map((row) => row.label);
    }

    const KICKERS_PAGE = { title: 'Little Kickers Saturday | Example Sport', url: KICKERS_URL };

    it("is the coach model's name when the parent's words or a page this turn wrote it", async () => {
      expect(
        await storedLabel({
          activity: 'Little Kickers',
          words: `can you sign her up for little kickers? ${KICKERS_URL}`,
          links: [],
        }),
      ).toEqual(['Little Kickers']);
      expect(
        await storedLabel({
          activity: 'Little Kickers',
          words: 'can you sign her up for that one?',
          links: [KICKERS_PAGE],
        }),
      ).toEqual(['Little Kickers']);
    });

    it('a name only the coach model wrote is never stored: the page title stands in, or none', async () => {
      // Words of a name the parent or a page wrote, never a fragment of one of their words.
      expect(
        await storedLabel({
          activity: 'Yes Please Cancel',
          words: 'can you sign her up for that one?',
          links: [KICKERS_PAGE],
        }),
      ).toEqual(['Little Kickers Saturday | Example Sport']);
      expect(
        await storedLabel({
          activity: 'Kick',
          words: `can you sign her up for little kickers? ${KICKERS_URL}`,
          links: [],
        }),
      ).toEqual([null]);
      expect(
        await storedLabel({
          activity: 'Little Kickers',
          words: `can you sign her up? ${KICKERS_URL}`,
          links: [],
        }),
      ).toEqual([null]);
    });
  });
});
