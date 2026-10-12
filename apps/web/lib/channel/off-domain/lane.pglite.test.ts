import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { GENERAL_ANSWER_SEARCH_ENABLED_ENV } from './answer';
import { type InboundThread, productionOffDomainLane, readPendingAsk } from './lane';

/**
 * The lane's reads of the family through its PRODUCTION wiring, against the real DDL.
 *
 * answer.test.ts hands the composer a place and proves what is done with it. What it
 * cannot prove is where production gets that place from: an injected reader cannot fail
 * on a bug inside the real one. Here the real reader runs against a real row, on the
 * model seams the lane's own tests script, and what is asserted is what left for each
 * model call. Every row is invented.
 */

const SCREEN_HEADING = 'Which lane does this text belong in';
const SANITIZE_HEADING = 'Take the family out, keep the question';

interface Request {
  system?: string | Array<{ text: string }>;
  messages: Array<{ content: string }>;
}

const systemText = (request: Request) =>
  typeof request.system === 'string'
    ? request.system
    : (request.system ?? []).map((block) => block.text).join('');

const structured = (payload: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** The parent's own text thread, a chat of their own with Hale, and a chat with others in it. */
const DIRECT: InboundThread = { channel: 'sms', providerChatId: null, inGroup: false };
const OWN_CHAT: InboundThread = { channel: 'imessage', providerChatId: 'chat-own', inGroup: false };
const GROUP_CHAT: InboundThread = {
  channel: 'imessage',
  providerChatId: 'chat-group',
  inGroup: true,
};
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** The lane's one client: a screen that files the text as off-topic, a sanitizer that
 * reads it as depending on where the family is (and, handed a pending ask, as the reply
 * to it), a search that found something. */
function scripted() {
  const seen: { sanitize: string[]; search: string[]; compose: string[] } = {
    sanitize: [],
    search: [],
    compose: [],
  };
  const client = () =>
    ({
      messages: {
        async create(request: Request) {
          const system = systemText(request);
          const content = request.messages[0]?.content ?? '';
          if (system.includes(SCREEN_HEADING)) {
            return structured({ lane: 'off_domain_general', category: 'weather', reason: 'x' });
          }
          if (system.includes(SANITIZE_HEADING)) {
            seen.sanitize.push(content);
            if ('pending' in JSON.parse(content)) {
              return structured({
                language: 'en',
                answers_pending: 'yes',
                question: 'hows the weather tomorrow in Maplewood',
                missing_detail: 'none',
                their_place: 'not_needed',
                current_fact: 'the forecast',
                needs_search: 'yes',
              });
            }
            return structured({
              language: 'en',
              answers_pending: 'nothing_pending',
              question: 'hows the weather tomorrow',
              missing_detail: 'which city',
              their_place: 'needed',
              current_fact: 'the forecast',
              needs_search: 'missing_detail',
            });
          }
          seen.compose.push(content);
          return structured({ answer: 'Sunny, high of 14.' });
        },
        stream(request: Request) {
          seen.search.push(request.messages[0]?.content ?? '');
          return {
            async finalMessage() {
              return {
                content: [
                  {
                    type: 'web_search_tool_result',
                    tool_use_id: 'srvtoolu_1',
                    content: [{ type: 'web_search_result', url: 'https://weather.example/f' }],
                  },
                  { type: 'text', text: 'Sunny tomorrow, high of 14, per the forecast.' },
                ],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 },
              };
            },
          };
        },
      },
    }) as unknown as AgentClient;
  return { client, seen };
}

let db: TestDb;
let households = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(place: {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
  areaCoarse: string | null;
}) {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: `Household ${households}`, provinceOrState: 'ON', ...place })
    .returning({ id: schema.families.id });
  const [parent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms_place_${households}` })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = parent?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'hows the weather tomorrow',
    })
    .returning({ id: schema.channelMessages.id });
  return { familyId, parentUserId, channelMessageId: inbound?.id as string };
}

/** Every statement the lane runs, as text: the shape of a read, which no answer shows. */
function watchQueries(): string[] {
  const queries: string[] = [];
  const query = db.client.query.bind(db.client);
  vi.spyOn(db.client, 'query').mockImplementation((sql: string, ...rest: unknown[]) => {
    queries.push(sql);
    return (query as (...args: unknown[]) => ReturnType<typeof query>)(sql, ...rest);
  });
  return queries;
}

const readsOfTheFamilyRow = (queries: string[]) =>
  queries.filter((sql) => sql.includes('from "families"'));

describe("the family's city and country, through the production wiring", () => {
  /** How a family that signed up by text is stored: a country, a postal code and its
   * area, and no city. The city is worked out from the postal area. */
  it('sends the search a city and a country for a family stored the way intake stores one, and nothing finer', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily({
      country: 'Canada',
      province: 'Ontario',
      city: null,
      postalCode: 'M4K 1A1',
      areaCoarse: 'M4K',
    });
    const { client, seen } = scripted();
    const queries = watchQueries();

    const verdict = await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'hows the weather tomorrow',
      now: NOW,
      thread: DIRECT,
    });

    expect(verdict).toMatchObject({ status: 'deflected', reply: 'Sunny, high of 14.' });
    expect(seen.search.map((content) => JSON.parse(content).place)).toEqual([
      { city: 'Toronto', country: 'Canada' },
    ]);
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain('M4K');
    expect(sent).not.toContain('1A1');
    expect(sent).not.toContain('Ontario');
    expect(sent).not.toContain('"ON"');
    // The place is the search's alone.
    expect(JSON.stringify([seen.sanitize, seen.compose])).not.toContain('Toronto');
    // One read of the family's row, and the province is not among what it selects.
    const reads = readsOfTheFamilyRow(queries);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('"postal_code"');
    expect(reads[0]).not.toContain('province');
  });

  it("sends the family's own stored city and country when both are stored", async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily({
      country: 'Canada',
      province: 'Nova Scotia',
      city: 'Halifax',
      postalCode: 'A1A 1A1',
      areaCoarse: 'A1A',
    });
    const { client, seen } = scripted();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'hows the weather tomorrow',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.search.map((content) => JSON.parse(content).place)).toEqual([
      { city: 'Halifax', country: 'Canada' },
    ]);
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain('A1A');
    expect(sent).not.toContain('Nova Scotia');
  });

  /** Sloane's finding 1: the lane's own postal table, not the registration radar's map,
   * so a family outside the GTA, and one with a ZIP code, has a city too. */
  it.each([
    [
      'a Canadian family outside the GTA',
      { country: 'Canada', province: 'British Columbia', postalCode: 'V6B 1A1', areaCoarse: 'V6B' },
      { city: 'Vancouver', country: 'Canada' },
      ['V6B', '1A1', 'British Columbia'],
    ],
    [
      'a US family',
      { country: 'United States', province: 'Colorado', postalCode: '80202', areaCoarse: '802' },
      { city: 'Denver', country: 'United States' },
      ['80202', '802', 'Colorado'],
    ],
  ])('sends the search the city of %s, worked out from the postal code', async (_label, stored, place, never) => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily({ city: null, ...stored });
    const { client, seen } = scripted();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'hows the weather tomorrow',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.search.map((content) => JSON.parse(content).place)).toEqual([place]);
    const sent = JSON.stringify(seen);
    for (const finer of never) expect(sent).not.toContain(finer);
  });

  /** A stored city is free text, and none of it leaves. One that is not a place name is
   * ignored, and the city is the one the family's postal area belongs to. */
  it('sends nothing of a stored city that is not a place name, and uses the postal area', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily({
      country: 'Canada',
      province: 'Ontario',
      city: '12 Maplewick Crescent',
      postalCode: 'M4K 1A1',
      areaCoarse: 'M4K',
    });
    const { client, seen } = scripted();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'hows the weather tomorrow',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.search.map((content) => JSON.parse(content).place)).toEqual([
      { city: 'Toronto', country: 'Canada' },
    ]);
    expect(JSON.stringify(seen)).not.toMatch(/Maplewick|Crescent|redacted/);
  });

  /**
   * A reply in a group goes to everyone in it. The family's row is not read for a text
   * that arrived in a group, or in a thread the job does not describe, and the turn asks
   * which city as it did before a place existed.
   */
  it.each([
    ['a group thread', { ...GROUP_CHAT }, 'group_thread'],
    ['a thread the job does not describe', { ...OWN_CHAT, inGroup: undefined }, 'thread_unknown'],
  ])("reads no family row and sends no place in %s", async (_label, thread, reason) => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stored = {
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M4K 1A1',
      areaCoarse: 'M4K',
    };
    const { familyId, parentUserId, channelMessageId } = await seedFamily(stored);
    const { client, seen } = scripted();
    const queries = watchQueries();
    const turn = { familyId, parentUserId, channelMessageId, text: 'hows the weather tomorrow' };

    await productionOffDomainLane(db.database, client).consider({ ...turn, now: NOW, thread });

    expect(seen.search).toEqual([]);
    expect(seen.compose.map((content) => JSON.parse(content).live)).toEqual(['missing_detail']);
    expect(JSON.stringify(seen)).not.toContain('Toronto');
    expect(readsOfTheFamilyRow(queries)).toEqual([]);
    expect(info.mock.calls).toContainEqual([
      { place: 'unknown', reason },
      'off-domain answer: no place for this family',
    ]);

    // Positive control: the same family and text in the parent's own chat is searched
    // for their city.
    const own = scripted();
    await productionOffDomainLane(db.database, own.client).consider({
      ...turn,
      now: NOW,
      thread: OWN_CHAT,
    });
    expect(own.seen.search.map((content) => JSON.parse(content).place)).toEqual([
      { city: 'Toronto', country: 'Canada' },
    ]);
    expect(readsOfTheFamilyRow(queries)).toHaveLength(1);
  });

  it('reads no place and sends none while the flag is dark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily({
      country: 'Canada',
      province: 'Ontario',
      city: 'Toronto',
      postalCode: 'M4K 1A1',
      areaCoarse: 'M4K',
    });
    const { client, seen } = scripted();
    const queries = watchQueries();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'hows the weather tomorrow',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.search).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('Toronto');
    // Positive control: the turn did read the database (the date's timezone).
    expect(queries.some((sql) => sql.includes('"family_members"'))).toBe(true);
    expect(readsOfTheFamilyRow(queries)).toEqual([]);
  });
});

/** A reply Hale sent, as the router writes its ledger row. */
async function sentReply(input: {
  familyId: string;
  parentUserId: string;
  createdAt: Date;
  pending?: { question: string; missing: string | null };
  status?: 'sent' | 'delivered' | 'failed';
  /** The thread the reply went out in. The parent's own text thread unless said. */
  thread?: InboundThread;
}) {
  const thread = input.thread ?? DIRECT;
  await db.database.insert(schema.channelMessages).values({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    channel: thread.channel,
    providerChatId: thread.providerChatId,
    direction: 'out',
    category: 'reply',
    status: input.status ?? 'sent',
    body: null,
    pendingQuestion: input.pending?.question ?? null,
    pendingMissing: input.pending?.missing ?? null,
    createdAt: input.createdAt,
    sentAt: input.createdAt,
  });
}

const NO_PLACE = { country: null, province: null, city: null, postalCode: null, areaCoarse: null };
const ASKED = { question: 'hows the weather tomorrow', missing: 'which city' };

/**
 * A question Hale left open (Sloane's finding 1), against the real ledger. "Is it still
 * pending" is a read of `channel_messages`, so what a fake reader would stipulate is
 * exactly what has to be proven: which row counts as Hale's last word.
 */
describe('a question Hale left open, through the production wiring', () => {
  it("reads the parent's next text beside the question the last reply left open", async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily(NO_PLACE);
    await sentReply({ familyId, parentUserId, createdAt: minutesBefore(2), pending: ASKED });
    const { client, seen } = scripted();

    const verdict = await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'Maplewood',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.sanitize.map((content) => JSON.parse(content))).toEqual([
      { text: 'Maplewood', pending: ASKED },
    ]);
    expect(seen.search.map((content) => JSON.parse(content).question)).toEqual([
      'hows the weather tomorrow in Maplewood',
    ]);
    expect(verdict).toMatchObject({
      status: 'deflected',
      reply: 'Sunny, high of 14.',
      signal: 'not_applicable',
      pendingAsk: null,
    });
  });

  /** Sloane's finding 2, end to end: asked in the parent's own chat, and their next text
   * comes from a group. It is read as a text of its own, and nothing of the question
   * goes anywhere. */
  it('does not continue a question for a text in another chat, and reads the ledger for none the job does not describe', async () => {
    vi.stubEnv(GENERAL_ANSWER_SEARCH_ENABLED_ENV, 'true');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily(NO_PLACE);
    await sentReply({
      familyId,
      parentUserId,
      createdAt: minutesBefore(2),
      pending: ASKED,
      thread: OWN_CHAT,
    });
    const turn = { familyId, parentUserId, channelMessageId, text: 'Maplewood', now: NOW };
    const pendingReads = (queries: string[]) =>
      queries.filter((sql) => sql.includes('pending_question'));

    const group = scripted();
    const groupQueries = watchQueries();
    await productionOffDomainLane(db.database, group.client).consider({
      ...turn,
      thread: GROUP_CHAT,
    });
    expect(group.seen.sanitize.map((content) => JSON.parse(content))).toEqual([
      { text: 'Maplewood' },
    ]);
    // The combined question is the one thing only a continued turn searches for.
    expect(JSON.stringify(group.seen)).not.toContain('hows the weather tomorrow in Maplewood');
    expect(pendingReads(groupQueries)).toHaveLength(1);
    expect(info.mock.calls).toContainEqual([
      { pendingAsk: 'other_thread' },
      'off-domain lane: no pending ask for this parent',
    ]);
    vi.restoreAllMocks();

    vi.spyOn(console, 'info').mockImplementation(() => {});
    const unsaid = scripted();
    const unsaidQueries = watchQueries();
    await productionOffDomainLane(db.database, unsaid.client).consider({
      ...turn,
      thread: { ...OWN_CHAT, inGroup: undefined },
    });
    expect(unsaid.seen.sanitize.map((content) => JSON.parse(content))).toEqual([
      { text: 'Maplewood' },
    ]);
    expect(pendingReads(unsaidQueries)).toEqual([]);
    vi.restoreAllMocks();

    // Positive control: the same text in the chat the question was asked in completes it.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const own = scripted();
    await productionOffDomainLane(db.database, own.client).consider({ ...turn, thread: OWN_CHAT });
    expect(own.seen.sanitize.map((content) => JSON.parse(content))).toEqual([
      { text: 'Maplewood', pending: ASKED },
    ]);
    expect(own.seen.search.map((content) => JSON.parse(content).question)).toEqual([
      'hows the weather tomorrow in Maplewood',
    ]);
  });

  it('reads no pending ask while the flag is dark, whatever the ledger holds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { familyId, parentUserId, channelMessageId } = await seedFamily(NO_PLACE);
    await sentReply({ familyId, parentUserId, createdAt: minutesBefore(2), pending: ASKED });
    const { client, seen } = scripted();
    const queries = watchQueries();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      parentUserId,
      channelMessageId,
      text: 'Maplewood',
      now: NOW,
      thread: DIRECT,
    });

    expect(seen.sanitize.map((content) => JSON.parse(content))).toEqual([{ text: 'Maplewood' }]);
    // Positive control: the turn did touch the ledger (the demand-signal stamp).
    expect(queries.some((sql) => sql.includes('"channel_messages"'))).toBe(true);
    expect(queries.filter((sql) => sql.includes('pending_question'))).toEqual([]);
  });
});

describe('readPendingAsk', () => {
  const read = (
    input: { familyId: string; parentUserId: string },
    asOf = NOW,
    thread: InboundThread = DIRECT,
  ) =>
    readPendingAsk(db.database)({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: thread.channel,
      providerChatId: thread.providerChatId,
      asOf,
    });
  const OPEN = { status: 'open', ask: ASKED };
  const NONE = { status: 'none' };

  it('returns the question the last reply left open, and an empty missing when none was kept', async () => {
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(2), pending: ASKED });
    expect(await read(parent)).toEqual(OPEN);

    const other = await seedFamily(NO_PLACE);
    await sentReply({
      ...other,
      createdAt: minutesBefore(2),
      pending: { question: 'did the raptors win last night', missing: null },
    });
    expect(await read(other)).toEqual({
      status: 'open',
      ask: { question: 'did the raptors win last night', missing: '' },
    });
  });

  /** One shot. Whatever Hale says next, the answer or anything else, is a newer last
   * word, so the question is not there for the text after it. */
  it('finds nothing once Hale has said anything since', async () => {
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(10), pending: ASKED });
    await sentReply({ ...parent, createdAt: minutesBefore(5) });

    expect(await read(parent)).toEqual(NONE);
  });

  /** A text the turn itself sends while it works (the holding line) is newer than the
   * turn's clock, and must not close the ask the turn is about to read. */
  it('ignores what was sent after the turn began', async () => {
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(2), pending: ASKED });
    await sentReply({ ...parent, createdAt: new Date(NOW.getTime() + 9_000) });

    expect(await read(parent)).toEqual(OPEN);
  });

  it('does not count a send that failed as a last word', async () => {
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(10), pending: ASKED });
    await sentReply({ ...parent, createdAt: minutesBefore(5), status: 'failed' });
    expect(await read(parent)).toEqual(OPEN);

    const unasked = await seedFamily(NO_PLACE);
    await sentReply({ ...unasked, createdAt: minutesBefore(2), pending: ASKED, status: 'failed' });
    expect(await read(unasked)).toEqual(NONE);
  });

  /** It was put to one phone. Another parent's text is not the reply to it, in the same
   * household or any other. */
  it("does not read one parent's question for another", async () => {
    const asked = await seedFamily(NO_PLACE);
    await sentReply({ ...asked, createdAt: minutesBefore(2), pending: ASKED });
    const [partner] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms_place_partner' })
      .returning({ id: schema.users.id });
    const partnerId = partner?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: asked.familyId, userId: partnerId, role: 'co_parent' });
    const stranger = await seedFamily(NO_PLACE);

    expect(await read({ familyId: asked.familyId, parentUserId: partnerId })).toEqual(NONE);
    expect(await read(stranger)).toEqual(NONE);
    // Positive control: the parent it was put to still has it.
    expect(await read(asked)).toEqual(OPEN);
  });

  /**
   * Sloane's finding 2. A question is open to a text in the thread it was asked in and
   * nowhere else: the answer goes to whoever is in the chat the next text came from.
   */
  it('does not read a question asked in the parent\'s own chat for a text in a group, or the reverse', async () => {
    const OTHER = { status: 'other_thread' };
    const inOwnChat = await seedFamily(NO_PLACE);
    await sentReply({
      ...inOwnChat,
      createdAt: minutesBefore(2),
      pending: ASKED,
      thread: OWN_CHAT,
    });
    expect(await read(inOwnChat, NOW, GROUP_CHAT)).toEqual(OTHER);
    // Positive control: the chat it was asked in still has it.
    expect(await read(inOwnChat, NOW, OWN_CHAT)).toEqual(OPEN);

    const inGroup = await seedFamily(NO_PLACE);
    await sentReply({ ...inGroup, createdAt: minutesBefore(2), pending: ASKED, thread: GROUP_CHAT });
    expect(await read(inGroup, NOW, OWN_CHAT)).toEqual(OTHER);
    expect(await read(inGroup, NOW, GROUP_CHAT)).toEqual(OPEN);
  });

  /** The same chat id on another channel, and the same channel with no chat, are other
   * threads too. A plain text thread has no chat id on either side, and is one thread. */
  it('matches the channel and the chat, both', async () => {
    const OTHER = { status: 'other_thread' };
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(2), pending: ASKED, thread: OWN_CHAT });

    expect(await read(parent, NOW, { ...OWN_CHAT, channel: 'sms' })).toEqual(OTHER);
    expect(await read(parent, NOW, { ...OWN_CHAT, providerChatId: null })).toEqual(OTHER);
    expect(await read(parent, NOW, DIRECT)).toEqual(OTHER);

    const texting = await seedFamily(NO_PLACE);
    await sentReply({ ...texting, createdAt: minutesBefore(2), pending: ASKED });
    expect(await read(texting, NOW, DIRECT)).toEqual(OPEN);
    expect(await read(texting, NOW, OWN_CHAT)).toEqual(OTHER);
  });

  /** One shot across threads: Hale's last word to this parent is its last word anywhere.
   * A later reply in the group closes the question asked in their own chat. */
  it('finds nothing in the chat a question was asked in once Hale has answered the parent elsewhere', async () => {
    const parent = await seedFamily(NO_PLACE);
    await sentReply({ ...parent, createdAt: minutesBefore(10), pending: ASKED, thread: OWN_CHAT });
    await sentReply({ ...parent, createdAt: minutesBefore(5), thread: GROUP_CHAT });

    expect(await read(parent, NOW, OWN_CHAT)).toEqual(NONE);
    expect(await read(parent, NOW, GROUP_CHAT)).toEqual(NONE);
  });
});
