import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { GENERAL_ANSWER_SEARCH_ENABLED_ENV } from './answer';
import { productionOffDomainLane } from './lane';

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

/** The lane's one client: a screen that files the text as off-topic, a sanitizer that
 * reads it as depending on where the family is, a search that found something. */
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
    const { familyId, channelMessageId } = await seedFamily({
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
      channelMessageId,
      text: 'hows the weather tomorrow',
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
    const { familyId, channelMessageId } = await seedFamily({
      country: 'Canada',
      province: 'Nova Scotia',
      city: 'Halifax',
      postalCode: 'A1A 1A1',
      areaCoarse: 'A1A',
    });
    const { client, seen } = scripted();

    await productionOffDomainLane(db.database, client).consider({
      familyId,
      channelMessageId,
      text: 'hows the weather tomorrow',
    });

    expect(seen.search.map((content) => JSON.parse(content).place)).toEqual([
      { city: 'Halifax', country: 'Canada' },
    ]);
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain('A1A');
    expect(sent).not.toContain('Nova Scotia');
  });

  it('reads no place and sends none while the flag is dark', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { familyId, channelMessageId } = await seedFamily({
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
      channelMessageId,
      text: 'hows the weather tomorrow',
    });

    expect(seen.search).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('Toronto');
    // Positive control: the turn did read the database (the date's timezone).
    expect(queries.some((sql) => sql.includes('"family_members"'))).toBe(true);
    expect(readsOfTheFamilyRow(queries)).toEqual([]);
  });
});
