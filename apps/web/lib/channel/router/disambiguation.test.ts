import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  DISAMBIGUATION_TTL_MS,
  type PendingDisambiguation,
  createDisambiguationStore,
  matchDisambiguation,
} from './disambiguation';
import type { OpenQuestion } from './open-questions';

/**
 * VIL-304 — picking one of the options Hale printed.
 *
 * The matcher is the whole safety argument in one pure function, so it is tested directly
 * rather than only through the router: every branch here decides whether somebody's yes
 * gets applied to a calendar write or to a message sent into another household, and a
 * decision that can be read straight out of its inputs is one that can be PROVEN rather
 * than sampled.
 */

const WELCOME: OpenQuestion = {
  id: 'offer-1',
  kind: 'founder_welcome_offer',
  description: 'An offer to send your welcome note to a new family.',
  subject: 'sending your welcome note to the new family',
  answerable: { yes: true, no: true },
};

const CALENDAR: OpenQuestion = {
  id: 'action-1',
  kind: 'approval',
  description: 'Add to your calendar',
  subject: 'add to your calendar',
  answerable: { yes: true, no: true },
};

const DIGEST: OpenQuestion = {
  id: 'action-2',
  kind: 'approval',
  description: 'Note it in your digest',
  subject: 'note in your digest',
  answerable: { yes: true, no: true },
};

function menu(
  questions: readonly OpenQuestion[],
  overrides: Partial<PendingDisambiguation> = {},
): PendingDisambiguation {
  return {
    id: 'menu-1',
    polarity: 'yes',
    numbered: true,
    options: questions.map((q) => ({ questionId: q.id, kind: q.kind, subject: q.subject })),
    ...overrides,
  };
}

describe('the words a parent uses to pick', () => {
  it('resolves the option quoted back verbatim - the 2026-08-24 transcript', () => {
    const open = [CALENDAR, WELCOME, DIGEST];

    expect(
      matchDisambiguation(menu(open), 'sending your welcome note to the new family', open),
    ).toEqual({
      status: 'chosen',
      option: { questionId: 'offer-1', kind: 'founder_welcome_offer', subject: WELCOME.subject },
      polarity: 'yes',
    });
  });

  it('resolves a short paraphrase that names one option and only one', () => {
    const open = [CALENDAR, WELCOME, DIGEST];

    // "note" belongs to two of them and cannot choose; "welcome" belongs to one.
    expect(matchDisambiguation(menu(open), 'the welcome note one', open)).toMatchObject({
      status: 'chosen',
      option: { questionId: 'offer-1' },
    });
    expect(matchDisambiguation(menu(open), 'calendar please', open)).toMatchObject({
      status: 'chosen',
      option: { questionId: 'action-1' },
    });
    expect(matchDisambiguation(menu(open), 'digest', open)).toMatchObject({
      status: 'chosen',
      option: { questionId: 'action-2' },
    });
  });

  it('refuses a word that belongs to more than one of the options', () => {
    // "note" is in "welcome note" AND "note in your digest". A word that cannot tell two
    // options apart is dropped rather than scored, so this picks nothing at all.
    const open = [WELCOME, DIGEST];

    expect(matchDisambiguation(menu(open), 'the note one', open)).toEqual({
      status: 'no_choice',
      reason: 'not_a_choice',
    });
  });

  it('refuses two options named at once', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), 'the calendar and the welcome one', open)).toEqual({
      status: 'no_choice',
      reason: 'names_several',
    });
  });

  it('sends an ordinary question on its way', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), 'what time is storytime on saturday', open)).toEqual({
      status: 'no_choice',
      reason: 'not_a_choice',
    });
  });
});

describe('the number, when a number was printed', () => {
  it('reads a bare ordinal against the list in print order', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), '2', open)).toMatchObject({
      status: 'chosen',
      option: { questionId: 'offer-1' },
    });
  });

  it('reads the approval grammars own ordinal too', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), 'yes 1', open)).toMatchObject({
      status: 'chosen',
      option: { questionId: 'action-1' },
    });
  });

  it('refuses an ordinal when the sentence that went out had no numbers in it', () => {
    // A coach that asked in its own words printed no list. "2" points at nothing, and
    // guessing which option it meant would be Hale answering its own invention.
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open, { numbered: false }), '2', open)).toEqual({
      status: 'no_choice',
      reason: 'ordinal_not_offered',
    });
  });

  it('refuses an ordinal past the end of the list', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), '3', open)).toEqual({
      status: 'no_choice',
      reason: 'ordinal_not_offered',
    });
  });
});

describe('the polarity is not re-decided here', () => {
  it('carries the answer the parent already gave, not one read off this reply', () => {
    // They said NO, Hale asked which, they named it. That is a decline of that one thing.
    const open = [CALENDAR, WELCOME];

    expect(
      matchDisambiguation(menu(open, { polarity: 'no' }), 'the welcome note', open),
    ).toMatchObject({ status: 'chosen', polarity: 'no' });
  });

  it('refuses a reply that now says the opposite', () => {
    // "no, the calendar one" after a YES is a person changing their mind or correcting
    // Hale, and reading it as an acceptance would apply consent to something they may
    // have just refused (rule #4). The coach takes that turn.
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), 'no the calendar one', open)).toEqual({
      status: 'no_choice',
      reason: 'changed_their_mind',
    });
  });
});

describe('what is still actually open', () => {
  it('refuses every option whose question has closed', () => {
    const open = [CALENDAR, WELCOME];
    const closed: OpenQuestion[] = [];

    expect(matchDisambiguation(menu(open), 'the welcome note', closed)).toEqual({
      status: 'no_choice',
      reason: 'nothing_open',
    });
  });

  it('refuses an option that can no longer take THIS answer', () => {
    // A drafted action Hale's own reviewer has not cleared can be declined and cannot be
    // accepted (open-questions.ts `answerable`). Binding a yes to one answers the parent
    // with a refusal, which is the 2026-08-20 defect.
    const unapproved: OpenQuestion = { ...CALENDAR, answerable: { yes: false, no: true } };

    expect(
      matchDisambiguation(menu([CALENDAR, WELCOME]), 'the calendar one', [unapproved, WELCOME]),
    ).toEqual({ status: 'no_choice', reason: 'not_a_choice' });
  });

  it('lets a bare yes through once only one option is left standing', () => {
    // The others closed themselves between the question and the answer, so the word that
    // was ambiguous a moment ago has stopped being ambiguous.
    expect(matchDisambiguation(menu([CALENDAR, WELCOME]), 'yes please', [WELCOME])).toMatchObject({
      status: 'chosen',
      option: { questionId: 'offer-1' },
    });
  });

  it('still refuses a bare yes while two are standing', () => {
    const open = [CALENDAR, WELCOME];

    expect(matchDisambiguation(menu(open), 'yes please', open)).toEqual({
      status: 'no_choice',
      reason: 'not_a_choice',
    });
  });
});

/**
 * The store, against REAL Postgres and the real committed DDL (lib/testing/pglite.ts).
 *
 * The two things worth proving here cannot be proven any other way: the partial unique
 * index is what makes "at most one live menu per parent" a fact rather than a convention,
 * and an upsert that names it has to actually conflict on it — a `targetWhere` that does
 * not line up with the index either 23505s in production or silently inserts a second live
 * row, and both of those look perfectly fine through a query-builder fake.
 */
describe('the menus own memory', () => {
  let db: TestDb;
  const NOW = new Date('2026-08-24T18:00:00.000Z');
  const store = createDisambiguationStore();

  // ONE Postgres for the file, and a fresh HOUSEHOLD per test. Booting a WASM instance per
  // test is what blew the hook timeout on the suite that already does it
  // (lib/testing/pglite.ts's own note), and every row here is scoped to a parent id anyway.
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const option = (q: OpenQuestion) => ({
    questionId: q.id,
    kind: q.kind,
    subject: q.subject,
  });

  async function household() {
    return seedFamily(db.database);
  }

  it('writes a menu down and hands back exactly what was printed', async () => {
    const seeded = await household();

    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR), option(WELCOME)],
      now: NOW,
    });

    expect(await store.pending(db.database, { ...seeded, now: NOW })).toEqual({
      id: expect.any(String),
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR), option(WELCOME)],
    });
  });

  it('supersedes rather than accumulating - one live menu per parent', async () => {
    const seeded = await household();

    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-2',
      polarity: 'no',
      numbered: false,
      options: [option(WELCOME)],
      now: NOW,
    });

    // The SECOND question is the one standing in front of them. Two live lists would be
    // two things one reply could be read against.
    expect(await store.pending(db.database, { ...seeded, now: NOW })).toMatchObject({
      polarity: 'no',
      numbered: false,
      options: [option(WELCOME)],
    });
    const counted = (await db.exec(
      `SELECT count(*)::int AS n FROM pending_disambiguations
       WHERE parent_user_id = '${seeded.parentUserId}'`,
    )) as Array<{ rows: Array<{ n: number }> }>;
    expect(counted[0]?.rows[0]?.n).toBe(1);
  });

  it('is gone once it has been spent', async () => {
    const seeded = await household();
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });
    const live = await store.pending(db.database, { ...seeded, now: NOW });

    await store.consume(db.database, { id: live?.id as string, now: NOW });

    expect(await store.pending(db.database, { ...seeded, now: NOW })).toBeNull();
    // And a spent row does not block the next question from being asked.
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-2',
      polarity: 'yes',
      numbered: true,
      options: [option(WELCOME)],
      now: NOW,
    });
    expect(await store.pending(db.database, { ...seeded, now: NOW })).toMatchObject({
      options: [option(WELCOME)],
    });
  });

  it('stops standing once it is stale', async () => {
    const seeded = await household();
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });

    const later = new Date(NOW.getTime() + DISAMBIGUATION_TTL_MS + 1000);
    expect(await store.pending(db.database, { ...seeded, now: later })).toBeNull();
    // The positive control for the assertion above: one second inside the window, the
    // same row is still there. Without it a broken read would pass this test.
    const inside = new Date(NOW.getTime() + DISAMBIGUATION_TTL_MS - 1000);
    expect(await store.pending(db.database, { ...seeded, now: inside })).not.toBeNull();
  });

  it('refuses a polarity that is not one of the two words', async () => {
    const seeded = await household();

    await expect(
      db.exec(`INSERT INTO pending_disambiguations
        (family_id, parent_user_id, asked_from, polarity, numbered, options)
        VALUES ('${seeded.familyId}', '${seeded.parentUserId}', 'msg-1', 'maybe', true, '[]'::jsonb)`),
    ).rejects.toThrow();
  });
});
