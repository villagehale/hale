import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, laneRequestFields, pickLane } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DEEP_FETCHES,
  MAX_DEEP_SEARCHES,
  RESEARCH_MAX_TOKENS,
  createDeepResearcher,
  toDeepSlots,
} from './deep';
import { FETCH_FRESHNESS_MS } from './evidence';
import type { ActivityQuery } from './deidentify';

/**
 * THE DEEP PASS — the leg that opens the venue's pages instead of reading snippets.
 *
 * The property this file exists for: A CLAIM ABOUT A PAGE REQUIRES A PAGE. A research turn
 * that opened nothing comes back `unread`, never `no_slots` — because "there is nothing
 * posted" and "I could not get into their schedule" are two different true sentences, and
 * the benchmark defect was Hale saying the first one while meaning the second.
 *
 * The words the model writes are the eval's job (rule #8); what is here is the mechanics
 * around them — the budgets, the two legs, and the shapes that come out.
 */

const QUERY: ActivityQuery = {
  subject: 'Cartwheels Gym Centre',
  window: 'this fall',
  town: 'Halton Hills',
  stage: 'toddler',
};

const SLOT = {
  name: 'Tiny Gym, Cartwheels Gym Centre',
  age_fit: 'walking to 3.5 years',
  when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
  price: '$124 per term',
  registration: 'Registration open since July 22',
  source_name: 'Cartwheels Gym Centre',
  source_url: 'https://cartwheelsgymcentre.com/programs.php',
};

function message(content: unknown[]): Anthropic.Message {
  return { content, stop_reason: 'end_turn', usage: {} } as unknown as Anthropic.Message;
}

function researchTurn(opts: {
  searches?: number;
  read?: string[];
  refused?: number;
  /** How long before `now` the provider actually pulled those pages. Fresh by default. */
  retrievedAgoMs?: number;
}) {
  const content: unknown[] = [];
  for (let i = 0; i < (opts.searches ?? 2); i += 1) {
    content.push({
      type: 'web_search_tool_result',
      content: [{ type: 'web_search_result', title: 'Programs', url: 'https://x.ca/p' }],
    });
  }
  for (const url of opts.read ?? []) {
    content.push({
      type: 'web_fetch_tool_result',
      content: {
        type: 'web_fetch_result',
        url,
        retrieved_at: new Date(Date.now() - (opts.retrievedAgoMs ?? 60_000)).toISOString(),
        content: { type: 'document', source: { type: 'text', data: 'Sundays 9:30 - 10:15' } },
      },
    });
  }
  for (let i = 0; i < (opts.refused ?? 0); i += 1) {
    content.push({
      type: 'web_fetch_tool_result',
      content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' },
    });
  }
  content.push({ type: 'text', text: 'Read the fall grid.' });
  return message(content);
}

function extractTurn(input: unknown) {
  return message([{ type: 'tool_use', name: 'activity_deep', input }]);
}

/**
 * A client that replays a script of turns and records every request it was given, and
 * WHICH TRANSPORT asked for it.
 *
 * The transport is recorded because it is the production defect: a non-streamed research
 * turn cannot finish (see the module note in deep.ts), so a test that cannot tell
 * `create` from `stream` is a test that passes against the request production never
 * completes.
 */
function scripted(turns: Anthropic.Message[]): {
  client: () => AgentClient;
  requests: Anthropic.MessageCreateParams[];
  transports: string[];
} {
  const requests: Anthropic.MessageCreateParams[] = [];
  const transports: string[] = [];
  let index = 0;
  const next = (params: Anthropic.MessageCreateParams) => {
    requests.push(params);
    const turn = turns[index];
    index += 1;
    if (!turn) throw new Error('deep test: script exhausted');
    return turn;
  };
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        transports.push('create');
        return next(params);
      },
      stream: (params: Anthropic.MessageCreateParams) => {
        transports.push('stream');
        const turn = next(params);
        return { finalMessage: async () => turn };
      },
    },
  } as unknown as AgentClient;
  return { client: () => client, requests, transports };
}

describe('toDeepSlots', () => {
  it('keeps a whole row and carries the registration fact and the citation', () => {
    const [slot] = toDeepSlots([SLOT]);

    expect(slot).toEqual({
      name: 'Tiny Gym, Cartwheels Gym Centre',
      ageFit: 'walking to 3.5 years',
      when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
      price: '$124 per term',
      registration: 'Registration open since July 22',
      sourceName: 'Cartwheels Gym Centre',
      sourceUrl: 'https://cartwheelsgymcentre.com/programs.php',
      source: 'web',
    });
  });

  it('drops a row with no citation - a fact with no page is a fact nobody read', () => {
    expect(toDeepSlots([{ ...SLOT, source_url: undefined }])).toEqual([]);
    expect(toDeepSlots([{ ...SLOT, source_url: 'not-a-url' }])).toEqual([]);
  });

  it('drops a row missing what identifies it, and keeps one missing only a detail', () => {
    expect(toDeepSlots([{ ...SLOT, name: '' }])).toEqual([]);
    expect(toDeepSlots([{ ...SLOT, age_fit: undefined }])).toEqual([]);

    const [kept] = toDeepSlots([{ ...SLOT, price: undefined, registration: undefined }]);
    expect(kept?.name).toBe(SLOT.name);
    expect(kept?.price).toBeNull();
    expect(kept?.registration).toBeNull();
  });
});

describe('createDeepResearcher', () => {
  /**
   * THE LEG THAT NEVER CAME BACK.
   *
   * Live probe against the real API on main @ 12dbea74, 2026-08-22, production wiring
   * (`activityClient`, 50s, no retries): `messages.create` on this exact request timed
   * out at 50,005 ms and 50,021 ms, and raised to a 600s ceiling it died at 120,014 ms
   * with a connection error — a non-streamed turn cannot survive this long whatever the
   * client timeout is. The same request STREAMED returned in 88,795 ms with 9 search
   * results and 3 pages read. So every production deep pass was `research_failed`, the
   * sweep silently fell back to the shallow snippet finder, and Hale told a parent the
   * fall dates "aren't posted yet" having opened nothing.
   */
  it('STREAMS the research turn - a non-streamed one cannot finish in production', async () => {
    const { client, transports } = scripted([
      researchTurn({ read: ['https://x.ca/p'] }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [SLOT] }),
    ]);

    await createDeepResearcher(client).research(QUERY);

    expect(transports).toEqual(['stream', 'create']);
  });

  it('states the lane knobs on the wire rather than inheriting the API default', async () => {
    const { client, requests } = scripted([
      researchTurn({ read: ['https://x.ca/p'] }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [SLOT] }),
    ]);

    await createDeepResearcher(client).research(QUERY);

    expect(requests[0]).toMatchObject({
      ...laneRequestFields(pickLane('extract')),
      max_tokens: RESEARCH_MAX_TOKENS,
    });
  });

  it('spends exactly two model legs and the stated tool budgets', async () => {
    const { client, requests } = scripted([
      researchTurn({ read: ['https://x.ca/p'] }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [SLOT] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    expect(result.status).toBe('read');
    expect(requests).toHaveLength(2);
    const tools = requests[0]?.tools as { name: string; max_uses: number }[];
    expect(tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search']);
    expect(tools.find((t) => t.name === 'web_search')?.max_uses).toBe(MAX_DEEP_SEARCHES);
    expect(tools.find((t) => t.name === 'web_fetch')?.max_uses).toBe(MAX_DEEP_FETCHES);
    // The extract leg is blind and toolless — it sees the notes, never the parent.
    expect(requests[1]?.tools).toHaveLength(1);
  });

  it('returns the slots it read, with the evidence behind them', async () => {
    const { client } = scripted([
      researchTurn({ searches: 2, read: ['https://x.ca/p', 'https://x.ca/q'], refused: 1 }),
      extractTurn({ pages_read: ['https://x.ca/p', 'https://x.ca/q'], slots: [SLOT] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    // Every count the audit row and the composer's licence are built from, on the result
    // itself — the run knew all four and handed back two (rule #11).
    expect(result).toMatchObject({
      status: 'read',
      searchResults: 2,
      pagesRead: 2,
      pagesStale: 0,
      pagesRefused: 1,
    });
    if (result.status !== 'read') throw new Error('expected read');
    expect(result.slots).toHaveLength(1);
  });

  it('reports a CACHED page read as stale - the provider opened it, but not today', async () => {
    const { client } = scripted([
      researchTurn({ read: ['https://x.ca/p'], retrievedAgoMs: FETCH_FRESHNESS_MS + 60_000 }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [SLOT] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    expect(result).toMatchObject({ status: 'read', pagesRead: 1, pagesStale: 1 });
  });

  it('carries the search count on an UNREAD turn too - the counts never go missing', async () => {
    const { client } = scripted([
      researchTurn({ searches: 3, read: [], refused: 2 }),
      extractTurn({ pages_read: [], slots: [] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    expect(result).toMatchObject({ status: 'unread', searchResults: 3, pagesRefused: 2 });
  });

  it('THE DEFECT: a turn that opened NO page is unread, never an empty result', async () => {
    // Every fetch refused — the live shape on the benchmark venue's own schedule page.
    // An empty slot list here would let the follow-up say "nothing is posted" about a
    // page nobody managed to open.
    const { client } = scripted([
      researchTurn({ read: [], refused: 3 }),
      extractTurn({ pages_read: [], slots: [] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    expect(result.status).toBe('unread');
    if (result.status !== 'unread') throw new Error('expected unread');
    expect(result.pagesRefused).toBe(3);
  });

  it('an opened page that genuinely carries nothing IS an empty result', async () => {
    // The positive control for the test above: read a page, find nothing, and that is a
    // true thing Hale may say.
    const { client } = scripted([
      researchTurn({ read: ['https://x.ca/p'] }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [] }),
    ]);

    const result = await createDeepResearcher(client).research(QUERY);

    expect(result.status).toBe('read');
    if (result.status !== 'read') throw new Error('expected read');
    expect(result.slots).toEqual([]);
  });

  it('a research turn that never searched is not grounded', async () => {
    const { client } = scripted([researchTurn({ searches: 0, read: [] })]);

    await expect(createDeepResearcher(client).research(QUERY)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'not_grounded',
    });
  });

  it('names the leg that failed rather than throwing at the sweep', async () => {
    const client = {
      messages: {
        stream: () => {
          throw new Error('boom');
        },
      },
    } as unknown as AgentClient;

    await expect(createDeepResearcher(() => client).research(QUERY)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'research_failed',
    });
  });

  it('reports an unresolvable client rather than throwing at wiring time', async () => {
    const result = await createDeepResearcher(() => {
      throw new Error('no key');
    }).research(QUERY);

    expect(result).toMatchObject({ status: 'unavailable', reason: 'client_unavailable' });
  });

  it('never puts the town or the stage anywhere but the de-identified payload', async () => {
    const { client, requests } = scripted([
      researchTurn({ read: ['https://x.ca/p'] }),
      extractTurn({ pages_read: ['https://x.ca/p'], slots: [SLOT] }),
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createDeepResearcher(client).research(QUERY);
    spy.mockRestore();

    const sent = JSON.stringify(requests[0]?.messages);
    expect(JSON.parse(JSON.parse(sent)[0].content)).toEqual({
      mode: 'deep_research',
      subject: 'Cartwheels Gym Centre',
      town: 'Halton Hills',
      stage: 'toddler',
      window: 'this fall',
    });
  });
});
