import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ASK_TIE_WINDOW_MS } from '~/lib/channel/router/open-questions';
import { sentSignupText } from '~/lib/signup/sent-text.fixture';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { loadLiveAsks } from './asks';
import { AUTHORIZED_SIGNUP_ENABLED_ENV } from './flag';
import { authorizedSignupHandler } from './handler';
import {
  AskOrderUnmarked,
  askStamp,
  loadLastAsked,
  loadPendingOffer,
  loadPendingOffers,
  recordSignupOffer,
} from './store';

// Invented hosts and programs only.
const NOW = new Date('2026-11-20T15:00:00.000Z');
const GYM_URL = 'https://gym.example-rec.test/register/tots';
const KICKERS_URL = 'https://kickers.example-sport.test/register/sat';
const SAME_HOST_URL = 'https://gym.example-rec.test/register/swim';
const SESSION = {
  id: 'sat-1015',
  label: 'Sat 10:15',
  startsAt: '2027-01-09T15:15:00.000Z',
  endsAt: '2027-01-09T16:00:00.000Z',
  full: false,
  priceCents: 12000,
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function family() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  return { ...seeded, childId };
}

function record(
  f: { familyId: string; parentUserId: string; childId: string },
  url: string,
  activityLabel: string,
  minutesAfter: number,
  supersede?: readonly string[],
) {
  return recordSignupOffer(db.database, {
    familyId: f.familyId,
    childId: f.childId,
    parentUserId: f.parentUserId,
    activityKey: `act-${minutesAfter}`,
    activityLabel,
    registrationUrl: url,
    sessions: [SESSION],
    approvedPriceCents: null,
    supersede,
    now: new Date(NOW.getTime() + minutesAfter * 60_000),
  });
}

/** A second adult in the household with full parent scope. */
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

async function statusOf(id: string) {
  const [row] = await db.database
    .select({
      status: schema.authorizedSignupOffers.status,
      label: schema.authorizedSignupOffers.activityLabel,
    })
    .from(schema.authorizedSignupOffers)
    .where(eq(schema.authorizedSignupOffers.id, id));
  return row;
}

async function supersededAudits(id: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after, actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.targetId, id),
        eq(schema.auditLog.actionTaken, 'authorized_signup_step'),
      ),
    );
  return rows.filter((row) => (row.after as { step?: string }).step === 'offer_superseded');
}

describe('several signup asks at once', () => {
  it('a new ask for another program leaves the earlier ask open', async () => {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!gym.ok) throw new Error(gym.reason);
    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 5);
    if (!kickers.ok) throw new Error(kickers.reason);

    expect(kickers.replaced).toEqual([]);
    expect(await statusOf(gym.id)).toEqual({ status: 'pending', label: 'Gymnastics Tots' });
    expect(await statusOf(kickers.id)).toEqual({ status: 'pending', label: 'Little Kickers' });
    expect(await supersededAudits(gym.id)).toEqual([]);
  });

  it('closes the earlier ask the parent replaced, audits it, and names it', async () => {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!gym.ok) throw new Error(gym.reason);
    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 5, [gym.id]);
    if (!kickers.ok) throw new Error(kickers.reason);

    expect(await statusOf(gym.id)).toEqual({ status: 'handed_back', label: 'Gymnastics Tots' });
    expect(kickers.replaced).toEqual([
      {
        offerId: gym.id,
        activityLabel: 'Gymnastics Tots',
        providerHost: 'gym.example-rec.test',
        sessionLabels: ['Sat 10:15'],
      },
    ]);
    const audits = await supersededAudits(gym.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(f.parentUserId);
    expect(audits[0]?.after).toEqual({
      step: 'offer_superseded',
      host: 'gym.example-rec.test',
      supersededBy: kickers.id,
    });
  });

  it("never closes the co-parent's ask, even when it is named", async () => {
    const f = await family();
    const coParentUserId = await seedCoParent(f.familyId);
    const theirs = await record(
      { ...f, parentUserId: coParentUserId },
      GYM_URL,
      'Gymnastics Tots',
      0,
    );
    if (!theirs.ok) throw new Error(theirs.reason);
    const mine = await record(f, KICKERS_URL, 'Little Kickers', 5, [theirs.id]);
    if (!mine.ok) throw new Error(mine.reason);

    expect(mine.replaced).toEqual([]);
    expect((await statusOf(theirs.id))?.status).toBe('pending');
    expect(await supersededAudits(theirs.id)).toEqual([]);
  });

  it('a second ask on the same site is refused unless it replaces the open one', async () => {
    const f = await family();
    const first = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!first.ok) throw new Error(first.reason);

    expect(await record(f, SAME_HOST_URL, 'Preschool Swim', 5)).toEqual({
      ok: false,
      reason: 'offer_exists',
    });
    expect((await statusOf(first.id))?.status).toBe('pending');

    const replacing = await record(f, SAME_HOST_URL, 'Preschool Swim', 6, [first.id]);
    expect(replacing.ok).toBe(true);
    expect((await statusOf(first.id))?.status).toBe('handed_back');
  });

  it('an approved plan is not an ask: naming it closes nothing', async () => {
    const f = await family();
    const planned = await record(f, GYM_URL, 'Gymnastics Tots', 0);
    if (!planned.ok) throw new Error(planned.reason);
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'planned' })
      .where(eq(schema.authorizedSignupOffers.id, planned.id));

    const next = await record(f, KICKERS_URL, 'Little Kickers', 5, [planned.id]);
    if (!next.ok) throw new Error(next.reason);
    expect(next.replaced).toEqual([]);
    expect((await statusOf(planned.id))?.status).toBe('planned');
    expect(await supersededAudits(planned.id)).toEqual([]);
  });

  it("never closes another family's ask", async () => {
    const mine = await family();
    const theirs = await family();
    const other = await record(theirs, GYM_URL, 'Gymnastics Tots', 0);
    if (!other.ok) throw new Error(other.reason);
    const own = await record(mine, KICKERS_URL, 'Little Kickers', 5, [other.id]);
    if (!own.ok) throw new Error(own.reason);
    expect(own.replaced).toEqual([]);
    expect((await statusOf(other.id))?.status).toBe('pending');
  });
});

describe('loadPendingOffers', () => {
  it('lists every pending ask newest first, and loads a named one as itself', async () => {
    const f = await family();
    // Two pending asks on different hosts.
    const rows = await db.database
      .insert(schema.authorizedSignupOffers)
      .values(
        [
          { url: KICKERS_URL, host: 'kickers.example-sport.test', minutes: 5 },
          { url: GYM_URL, host: 'gym.example-rec.test', minutes: 0 },
        ].map((row) => ({
          familyId: f.familyId,
          childId: f.childId,
          parentUserId: f.parentUserId,
          activityKey: `legacy-${row.minutes}`,
          registrationUrl: row.url,
          providerHost: row.host,
          sessions: [SESSION],
          status: 'pending',
          createdAt: new Date(NOW.getTime() + row.minutes * 60_000),
          updatedAt: new Date(NOW.getTime() + row.minutes * 60_000),
        })),
      )
      .returning({
        id: schema.authorizedSignupOffers.id,
        url: schema.authorizedSignupOffers.registrationUrl,
      });
    const newest = rows.find((row) => row.url === KICKERS_URL);
    const older = rows.find((row) => row.url === GYM_URL);
    if (!newest || !older) throw new Error('rows not inserted');

    expect((await loadPendingOffers(db.database, f.familyId)).map((row) => row.id)).toEqual([
      newest.id,
      older.id,
    ]);
    // A named ask is loaded as itself, so an older plan can still be approved.
    expect((await loadPendingOffer(db.database, f.familyId, older.id))?.id).toBe(older.id);
    const stranger = await family();
    expect(await loadPendingOffers(db.database, stranger.familyId)).toEqual([]);
    expect(await loadPendingOffer(db.database, stranger.familyId, older.id)).toBeNull();
  });
});

describe('askStamp: the ask number of a send', () => {
  async function twoAsks() {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gym Tots', 0);
    const kickers = await record(f, KICKERS_URL, 'Little Kickers', 1);
    if (!gym.ok || !kickers.ok) throw new Error('set-up offers');
    return { f, gymId: gym.id, kickersId: kickers.id };
  }
  const about = (f: { familyId: string; parentUserId: string }, offerId: string) => ({
    familyId: f.familyId,
    parentUserId: f.parentUserId,
    offerIds: [offerId],
  });
  /** The ledger row of a text that went to this parent. */
  const sent = (f: { familyId: string; parentUserId: string }) => sentSignupText(db.database, f);
  /** The ask whose text reached the parent last, or why none is. */
  async function lastAskedId(f: { familyId: string; parentUserId: string }) {
    const last = await loadLastAsked(db.database, f);
    return last.status === 'asked' ? last.offerId : last.status;
  }
  async function seqOf(offerId: string) {
    const [row] = await db.database
      .select({ seq: schema.authorizedSignupOffers.lastAskedSeq })
      .from(schema.authorizedSignupOffers)
      .where(eq(schema.authorizedSignupOffers.id, offerId));
    return row?.seq ?? null;
  }
  async function uncertainRow(f: { familyId: string; parentUserId: string }) {
    const [row] = await db.database
      .select()
      .from(schema.authorizedSignupAskOrderUncertain)
      .where(
        and(
          eq(schema.authorizedSignupAskOrderUncertain.familyId, f.familyId),
          eq(schema.authorizedSignupAskOrderUncertain.parentUserId, f.parentUserId),
        ),
      );
    return row ?? null;
  }
  async function failStampsOf(offerId: string) {
    await db.database.execute(sql`create or replace function store_test_fail_stamp() returns trigger as $$
      begin
        if new.id::text = current_setting('store_test.fail_offer') and new.last_asked_seq is distinct from old.last_asked_seq then
          raise exception 'store.pglite.test: the stamp fails';
        end if;
        return new;
      end $$ language plpgsql`);
    await db.database.execute(sql`select set_config('store_test.fail_offer', ${offerId}, false)`);
    await db.database.execute(
      sql`create trigger store_test_fail_stamp before update on authorized_signup_offers for each row execute function store_test_fail_stamp()`,
    );
  }
  afterEach(async () => {
    await db.database.execute(
      sql`drop trigger if exists store_test_fail_stamp on authorized_signup_offers`,
    );
    await db.database.execute(
      sql`drop trigger if exists store_test_fail_mark on authorized_signup_ask_order_uncertain`,
    );
    vi.restoreAllMocks();
  });

  async function failMarks() {
    await db.database.execute(sql`create or replace function store_test_fail_mark() returns trigger as $$
      begin
        raise exception 'store.pglite.test: the mark fails';
      end $$ language plpgsql`);
    await db.database.execute(
      sql`create trigger store_test_fail_mark before insert or update or delete on authorized_signup_ask_order_uncertain for each row execute function store_test_fail_mark()`,
    );
  }
  it('ranks asks by when their sends started', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    const gymKeep = await askStamp(db.database, about(f, gymId))();
    const kickersKeep = await askStamp(db.database, about(f, kickersId))();
    // Kickers' send was accepted first; Gym's started first.
    expect(await kickersKeep(await sent(f))).toBe('stamped');
    expect(await gymKeep(await sent(f))).toBe('stamped');
    expect(await lastAskedId(f)).toBe(kickersId);
    expect(await uncertainRow(f)).toBeNull();
  });

  it('holds every bare answer while a send is out, and after one whose outcome is unknown', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    await (await askStamp(db.database, about(f, gymId))())(await sent(f));
    expect(await lastAskedId(f)).toBe(gymId);

    // The send about Kickers is marked before its transport call. It never reports back
    // (a timeout after the carrier took the text, a 2xx with no id): its keep never runs.
    await askStamp(db.database, about(f, kickersId))();
    expect(await uncertainRow(f)).toMatchObject({ failures: 0 });
    expect(await lastAskedId(f)).toBe('uncertain');
    expect(await seqOf(kickersId)).toBeNull();

    // The next text about an ask that went clears it.
    expect(await (await askStamp(db.database, about(f, gymId))())(await sent(f))).toBe('stamped');
    expect(await uncertainRow(f)).toBeNull();
    expect(await lastAskedId(f)).toBe(gymId);
  });

  it('a keep clears the mark only when no send that started later is still out', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    const gymKeep = await askStamp(db.database, about(f, gymId))();
    const kickersKeep = await askStamp(db.database, about(f, kickersId))();
    expect(await gymKeep(await sent(f))).toBe('stamped');
    expect(await uncertainRow(f)).not.toBeNull();
    expect(await lastAskedId(f)).toBe('uncertain');
    expect(await kickersKeep(await sent(f))).toBe('stamped');
    expect(await uncertainRow(f)).toBeNull();
    expect(await lastAskedId(f)).toBe(kickersId);
  });

  it('never lowers a number a later-started send already kept', async () => {
    const { f, gymId } = await twoAsks();
    const first = await askStamp(db.database, about(f, gymId))();
    const second = await askStamp(db.database, about(f, gymId))();
    await second(await sent(f));
    const kept = await seqOf(gymId);
    await first(await sent(f));
    expect(await seqOf(gymId)).toBe(kept);
  });

  it('fails closed when the number is not kept: the mark made before the send holds until a later one is kept', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    await (await askStamp(db.database, about(f, gymId))())(await sent(f));
    expect(await lastAskedId(f)).toBe(gymId);
    const before = await askStamp(db.database, about(f, gymId))(); // started before the miss

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await failStampsOf(kickersId);
    expect(await (await askStamp(db.database, about(f, kickersId))())(await sent(f))).toBe(
      'ask_order_uncertain',
    );
    await db.database.execute(sql`drop trigger store_test_fail_stamp on authorized_signup_offers`);
    expect(await seqOf(kickersId)).toBeNull();
    expect(await uncertainRow(f)).toMatchObject({ failures: 1 });
    expect(await lastAskedId(f)).toBe('uncertain');
    expect(errors.mock.calls.some((call) => String(call[1]).includes('URGENT'))).toBe(false);

    // A number drawn before the miss, kept after it, does not settle the order.
    expect(await before(await sent(f))).toBe('stamped');
    expect(await lastAskedId(f)).toBe('uncertain');
    // One drawn after it does.
    expect(await (await askStamp(db.database, about(f, kickersId))())(await sent(f))).toBe(
      'stamped',
    );
    expect(await uncertainRow(f)).toBeNull();
    expect(await lastAskedId(f)).toBe(kickersId);
  });

  it('holds when the keep and every write after the send fail: the mark was made before it', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    await (await askStamp(db.database, about(f, gymId))())(await sent(f));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const keep = await askStamp(db.database, about(f, kickersId))();
    // The text went; now the stamp, the clear and the miss count all fail.
    await failStampsOf(kickersId);
    await failMarks();
    expect(await keep(await sent(f))).toBe('ask_order_uncertain');
    await db.database.execute(sql`drop trigger store_test_fail_stamp on authorized_signup_offers`);
    await db.database.execute(
      sql`drop trigger store_test_fail_mark on authorized_signup_ask_order_uncertain`,
    );
    expect(await seqOf(kickersId)).toBeNull();
    expect(await uncertainRow(f)).not.toBeNull();
    expect(await lastAskedId(f)).toBe('uncertain');
  });

  it('pages ops when a keep misses again before a number is kept', async () => {
    const { f, kickersId } = await twoAsks();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await failStampsOf(kickersId);
    await (await askStamp(db.database, about(f, kickersId))())(await sent(f));
    expect(errors.mock.calls.some((call) => String(call[1]).includes('URGENT'))).toBe(false);
    await (await askStamp(db.database, about(f, kickersId))())(await sent(f));
    expect(await uncertainRow(f)).toMatchObject({ failures: 2 });
    expect(
      errors.mock.calls.some((call) =>
        String(call[1]).includes('URGENT: signup_ask_order_uncertain'),
      ),
    ).toBe(true);
  });

  it('refuses the send when the mark cannot be written before it, and the order on file stands', async () => {
    const { f, gymId, kickersId } = await twoAsks();
    await (await askStamp(db.database, about(f, gymId))())(await sent(f));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await failMarks();
    await expect(askStamp(db.database, about(f, kickersId))()).rejects.toBeInstanceOf(
      AskOrderUnmarked,
    );
    await db.database.execute(
      sql`drop trigger store_test_fail_mark on authorized_signup_ask_order_uncertain`,
    );
    expect(await uncertainRow(f)).toBeNull();
    expect(await seqOf(kickersId)).toBeNull();
    expect(await lastAskedId(f)).toBe(gymId);
    expect(
      errors.mock.calls.some((call) =>
        String(call[1]).includes('URGENT: signup_ask_order_unmarked'),
      ),
    ).toBe(true);
  });
});

/**
 * VIL-302 · one newest-ask rule across lanes. The sign-up lane's newest ask takes a bare
 * answer only while Hale's last text about it is the newest of all the parent's asks, open
 * questions included (`newestAsks`); the router is handed that same text to rank.
 */
describe('the sign-up asks, ranked with the open questions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function askedGym() {
    const f = await family();
    const gym = await record(f, GYM_URL, 'Gym Tots', 0);
    if (!gym.ok) throw new Error('set-up offer');
    const about = { familyId: f.familyId, parentUserId: f.parentUserId, offerIds: [gym.id] };
    const carried = await sentSignupText(db.database, f);
    expect(await (await askStamp(db.database, about)())(carried)).toBe('stamped');
    const last = await loadLastAsked(db.database, f);
    if (last.status !== 'asked' || last.askedAt === null) throw new Error('set-up stamp');
    return { f, gymId: gym.id, about, askedAt: last.askedAt };
  }

  it('the last-asked sign-up ask is the newest only when no open question was asked after it', async () => {
    const { f, gymId, askedAt } = await askedGym();
    const at = (ms: number) => new Date(askedAt.getTime() + ms);
    const newest = async (openQuestions: readonly { askedAt: Date | null }[]) =>
      (await loadLiveAsks(db.database, { ...f, now: NOW, openQuestions }))
        .filter((ask) => ask.place.newest)
        .map((ask) => ask.offerId);

    expect(await newest([])).toEqual([gymId]);
    expect(await newest([{ askedAt: at(-ASK_TIE_WINDOW_MS) }])).toEqual([gymId]);
    expect(await newest([{ askedAt: at(ASK_TIE_WINDOW_MS) }])).toEqual([]);
    // Inside the tie window either way, or at the same time: a tie, and no sign-up ask binds.
    expect(await newest([{ askedAt: at(-ASK_TIE_WINDOW_MS + 1) }])).toEqual([]);
    expect(await newest([{ askedAt: at(ASK_TIE_WINDOW_MS - 1) }])).toEqual([]);
    expect(await newest([{ askedAt }])).toEqual([]);
    // Recency across the lanes cannot be established: no sign-up ask binds a bare answer.
    expect(await newest([{ askedAt: at(-60_000) }, { askedAt: null }])).toEqual([]);
  });

  it('is dated by the row that carried its last text, and that time never pairs with a lower number', async () => {
    const { f, gymId, about } = await askedGym();
    const datedAt = async (id: string, at: Date) =>
      db.database
        .update(schema.channelMessages)
        .set({ sendRecordedAt: at })
        .where(eq(schema.channelMessages.id, id));
    const offer = async () => {
      const [row] = await db.database
        .select()
        .from(schema.authorizedSignupOffers)
        .where(eq(schema.authorizedSignupOffers.id, gymId));
      return row;
    };
    // Two sends about Gym overlap: the second started later and its row recorded it first;
    // the first's row recorded its send later.
    const earlier = await askStamp(db.database, about)();
    const later = await askStamp(db.database, about)();
    const laterRow = await sentSignupText(db.database, f);
    await datedAt(laterRow, new Date(NOW.getTime() + 1_000));
    expect(await later(laterRow)).toBe('stamped');
    const kept = await offer();
    const earlierRow = await sentSignupText(db.database, f);
    await datedAt(earlierRow, new Date(NOW.getTime() + 2_000));
    expect(await earlier(earlierRow)).toBe('stamped');

    expect(await offer()).toMatchObject({
      lastAskedSeq: kept?.lastAskedSeq,
      lastAskedMessageId: laterRow,
      lastAskedAt: new Date(NOW.getTime() + 1_000),
    });
    expect(await loadLastAsked(db.database, f)).toEqual({
      status: 'asked',
      offerId: gymId,
      askedAt: new Date(NOW.getTime() + 1_000),
    });
  });

  it("hands the router Hale's last text: its time, unknown while a send is out, nothing before one", async () => {
    vi.stubEnv(AUTHORIZED_SIGNUP_ENABLED_ENV, 'on');
    const handler = authorizedSignupHandler();
    const ctx = (f: { familyId: string; parentUserId: string }) => ({
      ...f,
      body: 'yes',
      now: NOW,
      openQuestions: async () => [],
      inboundChannelMessageId: null,
    });

    const unasked = await family();
    if (!(await record(unasked, GYM_URL, 'Gym Tots', 0)).ok) throw new Error('set-up offer');
    expect(await handler.offListAsks?.(db.database, ctx(unasked))).toEqual([]);

    const { f, about, askedAt } = await askedGym();
    expect(await handler.offListAsks?.(db.database, ctx(f))).toEqual([{ askedAt }]);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await askStamp(db.database, about)();
    expect(await handler.offListAsks?.(db.database, ctx(f))).toEqual([{ askedAt: null }]);
  });
});
