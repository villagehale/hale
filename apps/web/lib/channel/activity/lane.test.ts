import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { isStage } from '~/lib/testing/structured-reply';
import * as sourcePage from '~/lib/registration/page';
import type { ActivityQuery } from './deidentify';
import {
  MAX_SEARCHES,
  composeUserMessage,
  createActivityFinder,
  groundUserMessage,
  toPicks,
} from './lane';

vi.mock('~/lib/registration/page', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/registration/page')>()),
  createRegistrationPageFetch: () => async () =>
    'Parent & Tot Gymnastics, Halton Hills Gymnastics Centre. 18 months - 3 years. Saturdays 9:15am, fall session from Sept 13. $142 for 12 weeks.',
}));

/**
 * THE LANE'S MECHANICS AND ITS INVARIANTS — not its judgement.
 *
 * Whether the picks it extracts are good ones is decided by a real model and measured in
 * apps/worker/evals/run-activity-finder-eval.mjs against real cached Claude (rule #8).
 * What is proven here is what the eval cannot reach: that an UNGROUNDED find never ships
 * (a venue a model remembered is a parent driving somewhere that is not there), that only
 * the de-identified query is ever searched, that a half-find is dropped rather than passed
 * on, that every pick is stamped `web` whatever the model says, and that a failure comes
 * back NAMED rather than as silence.
 *
 * Every negative assertion is paired with a positive control through the same path.
 */

const QUERY: ActivityQuery = {
  subject: 'toddler gymnastics',
  window: 'this fall',
  town: 'Halton Hills',
  stage: 'toddler',
};

const groundResult = (nResults: number) => ({
  content: [
    { type: 'text', text: 'Read the fall schedule page and the registration page.' },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtu_1',
      content:
        nResults > 0
          ? Array.from({ length: nResults }, (_, i) => ({
              type: 'web_search_result',
              url: `https://venue.example/${i}`,
              title: 'Fall programs',
              encrypted_content: 'x',
              page_age: null,
            }))
          : { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    },
  ],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'end_turn',
});

/** The same turn with the text block missing — real results, no research written. */
const groundResultWithoutNotes = (nResults: number) => ({
  ...groundResult(nResults),
  content: groundResult(nResults).content.filter((block) => block.type !== 'text'),
});

const composeResult = (input: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(input) }],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'end_turn',
});

const WHOLE_PICK = {
  name: 'Parent & Tot Gymnastics, Halton Hills Gymnastics Centre',
  age_fit: '18 months - 3 years',
  when: 'Saturdays 9:15am, fall session from Sept 13',
  price: '$142 for 12 weeks',
  source_name: 'Halton Hills Gymnastics Centre',
  source_url: 'https://venue.example/0',
};

interface Seen {
  tools?: Array<{ type?: string; max_uses?: number }>;
  toolChoice?: string;
  userMessage?: string;
}

type PhaseResponse = unknown | (() => unknown) | Error;

function makeClient(
  script: { ground?: PhaseResponse; compose?: PhaseResponse },
  seen: Seen[] = [],
): () => AgentClient {
  return () => {
    const messages = {
      // biome-ignore lint/suspicious/noExplicitAny: a fake driving the request mechanics
      async create(req: any) {
        const isCompose = isStage(req, 'activity_picks', 'picks');
        seen.push({
          tools: req.tools,
          toolChoice: isCompose ? 'activity_picks' : req.tools?.[0]?.name,
          userMessage: req.messages?.[0]?.content,
        });
        const pick = isCompose ? script.compose : script.ground;
        const resolved = typeof pick === 'function' ? (pick as () => unknown)() : pick;
        if (resolved instanceof Error) throw resolved;
        if (resolved === undefined) throw new Error('activity test: no script for this phase');
        return resolved;
      },
      // The ground turn streams. Compose still uses create. Delegating keeps the
      // recorded request the same object the eval corpus pins.
      stream(req: unknown) {
        return { finalMessage: () => messages.create(req) };
      },
    };
    return { messages } as unknown as AgentClient;
  };
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('the payloads', () => {
  it('sends the de-identified query and nothing else', () => {
    expect(groundUserMessage(QUERY)).toBe(
      '{"subject":"toddler gymnastics","town":"Halton Hills","stage":"toddler","window":"this fall"}',
    );
  });

  it('omits a town and a stage it does not have rather than sending a placeholder', () => {
    expect(
      groundUserMessage({ subject: 'story time', window: null, town: null, stage: null }),
    ).toBe('{"subject":"story time"}');
  });

  it('gives the compose stage the research and still no identity', () => {
    const payload = JSON.parse(composeUserMessage(QUERY, 'the notes'));
    expect(payload).toEqual({
      subject: 'toddler gymnastics',
      town: 'Halton Hills',
      stage: 'toddler',
      window: 'this fall',
      research_notes: 'the notes',
    });
  });
});

/**
 * THE WIRE SHAPE ITSELF, pinned as a literal — because a second copy of it lives in
 * apps/worker/evals/run-activity-finder-eval.mjs.
 *
 * That eval REPLICATES this request rather than importing it (the `~/` alias does not
 * resolve under its tsx loader), and a replica that has drifted is worse than no eval: it
 * scores a request production does not send, from a cache keyed on the wrong thing, and
 * reports PASS. The drift is silent by construction — nothing compiles across that seam.
 *
 * So the literals here are deliberate and are not to be replaced with the constants they
 * came from. Changing a budget SHOULD break this test, because changing a budget re-keys
 * the eval corpus and somebody has to go and re-record it.
 */
describe('the grounding request the eval corpus replays', () => {
  const LEGACY_TOOLS = '[{"name":"web_search","type":"web_search_20250305","max_uses":3}]';
  const VENUE_TOOLS = `[{"name":"web_search","type":"web_search_20250305","max_uses":3},{"name":"web_fetch","type":"web_fetch_20260209","max_uses":3}]`;

  async function toolsFor(subject: string): Promise<string> {
    const seen: Seen[] = [];
    await createActivityFinder(
      makeClient(
        { ground: groundResult(2), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    ).find({ ...QUERY, subject });
    return JSON.stringify(seen[0]?.tools);
  }

  it('a subject naming a PLACE buys the fetch budget - MAX_INLINE_FETCHES pages', async () => {
    expect(await toolsFor('Cartwheels Gym Centre')).toBe(VENUE_TOOLS);
  });

  it('CORPUS REPLAY - a generic subject gets the byte-identical pre-fetch request', async () => {
    // The other direction, and the one the eval depends on: a question with no one site to
    // open must still send exactly what it sent before `web_fetch` existed, or every
    // cached ground turn in the corpus is a replay of a request that is no longer made.
    expect(await toolsFor('toddler gymnastics')).toBe(LEGACY_TOOLS);
    expect(await toolsFor('indoor swim lessons this fall')).toBe(LEGACY_TOOLS);
  });
});

describe('an ungrounded find never ships', () => {
  it('does not compose from date-bearing snippets when every fresh source read fails', async () => {
    const fetch = vi.spyOn(sourcePage, 'createRegistrationPageFetch').mockReturnValue(async () => {
      throw Error('source unavailable');
    });
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResult(1), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    );
    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'not_grounded' });
    expect(seen.some((call) => call.toolChoice === 'activity_picks')).toBe(false);
    fetch.mockRestore();
  });
  it('drops a composed URL that was not among the pages just read', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({
          picks: [{ ...WHOLE_PICK, source_url: 'https://another.org/schedule' }],
        }),
      }),
    );
    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'no_picks' });
  });
  it('fails NAMED when the search returned no results, and never composes', async () => {
    const restore = quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResult(0), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    );

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'not_grounded' });
    // The compose stage was never reached — the model was never given a chance to write
    // a venue down from memory.
    expect(seen.some((call) => call.toolChoice === 'activity_picks')).toBe(false);
    restore.mockRestore();
  });

  /**
   * THE SHAPE THE EVAL CAUGHT. `preschool-swim-oakville` came back with 24 real search
   * results and an EMPTY notes string: the grounding turn spent its whole token budget on
   * the results and never wrote the summary. `countSearchResults` is satisfied by that, so
   * the lane composed from "" — and a composer handed no research either invents a venue
   * or shrugs, and shrugging is what a parent got. Search RESULTS are not RESEARCH.
   */
  it('fresh page text supports extraction even when search returned no prose', async () => {
    const restore = quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResultWithoutNotes(8), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    );

    expect(await finder.find(QUERY)).toMatchObject({ found: true });
    expect(seen.some((call) => call.toolChoice === 'activity_picks')).toBe(true);
    restore.mockRestore();
  });

  it('POSITIVE CONTROL - one real search result and the same picks ship', async () => {
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: [WHOLE_PICK] }) }),
    );

    const result = await finder.find(QUERY);
    expect(result).toMatchObject({ found: true });
    expect(result.found && result.picks).toHaveLength(1);
  });

  /**
   * POSITIVE CONTROL for the other half — and the shape a live probe caught.
   *
   * The grounding turn is handed ONE tool, `web_search`. Asked for Halton Hills drop-ins it
   * searched three times and then called `activity_picks` — a tool it was never given, but
   * which Step 2 of its own instructions describes — putting two real EarlyON finds in the
   * call and writing no prose at all. Reading only `text` blocks threw the whole answer
   * away as `empty_research` and told the parent Hale could not look. Research is what the
   * turn WROTE DOWN, wherever it put it.
   */
  it('reads the research the turn wrote into a tool call it was never given', async () => {
    const seen: Seen[] = [];
    const withToolNotes = {
      ...groundResultWithoutNotes(8),
      content: [
        ...groundResultWithoutNotes(8).content,
        { type: 'text', text: JSON.stringify({ picks: [WHOLE_PICK] }) },
      ],
    };
    const finder = createActivityFinder(
      makeClient({ ground: withToolNotes, compose: composeResult({ picks: [WHOLE_PICK] }) }, seen),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks.map((p) => p.name)).toEqual([WHOLE_PICK.name]);
    const composeCall = seen.find((call) => call.toolChoice === 'activity_picks');
    expect(composeCall?.userMessage).toContain(WHOLE_PICK.name);
  });

  it('bounds the search spend on every attempt', async () => {
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResult(2), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    );
    await finder.find(QUERY);

    expect(seen[0]?.tools?.[0]).toMatchObject({
      type: 'web_search_20250305',
      max_uses: MAX_SEARCHES,
    });
  });
});

describe('a pick is whole or it is not a pick', () => {
  it.each([
    ['no age fit', { ...WHOLE_PICK, age_fit: null }],
    ['no source', { ...WHOLE_PICK, source_name: '   ' }],
    ['no name', { ...WHOLE_PICK, name: undefined }],
  ])('drops a find with %s', async (_label, broken) => {
    const restore = quiet();
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: [broken] }) }),
    );

    // Dropping the only pick empties the list, which is the honest `no_picks` outcome and
    // NOT a retry: the search ran.
    expect(await finder.find(QUERY)).toMatchObject({ found: false, reason: 'no_picks' });
    restore.mockRestore();
  });

  it.each([
    ['PRICE', { ...WHOLE_PICK, price: null }],
    // The Oakville shape: a real program on a real municipal page whose fall class times
    // had not gone up yet. Dropping this is the shrug the lane exists to end.
    ['WHEN', { ...WHOLE_PICK, when: null }],
  ])('POSITIVE CONTROL - an unpublished %s is not a reason to drop a find', async (_l, partial) => {
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: [partial] }) }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks[0]).toMatchObject({ name: WHOLE_PICK.name });
  });

  it('carries the unpublished detail as null rather than as a guess', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({ picks: [{ ...WHOLE_PICK, when: '  ', price: undefined }] }),
      }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks[0]).toMatchObject({ when: null, price: null });
  });

  it('keeps the whole ones and drops the broken one from the same list', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({
          picks: [WHOLE_PICK, { ...WHOLE_PICK, name: 'Halfling', age_fit: '' }],
        }),
      }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks.map((p) => p.name)).toEqual([WHOLE_PICK.name]);
  });
});

describe('the model may hand the same picks back in either encoding', () => {
  // The corpus produced this on the incident's own fixture: two whole, grounded, real
  // finds off the gym's own pages, returned as `picks: "{\"picks\":[...]}"` - the envelope
  // JSON-encoded a second time into the field. An array reader sees a string, keeps
  // nothing, and the turn is `no_picks`: the shrug again, from a wire shape rather than a
  // judgement. Collapsed at the PARSE boundary, where both encodings mean one thing.
  it.each([
    ['the envelope, re-encoded', JSON.stringify({ picks: [WHOLE_PICK] })],
    ['the bare array, re-encoded', JSON.stringify([WHOLE_PICK])],
  ])('reads %s', async (_label, encoded) => {
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: encoded }) }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks.map((p) => p.name)).toEqual([WHOLE_PICK.name]);
  });

  it('POSITIVE CONTROL - a string that is not picks at all still fails NAMED', async () => {
    const restore = quiet();
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: 'no idea' }) }),
    );

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'compose_failed' });
    restore.mockRestore();
  });
});

describe('sourcing is stamped, never claimed', () => {
  it('marks every pick web-sourced even when the model tried to say otherwise', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({
          picks: [{ ...WHOLE_PICK, source: 'radar', verified: true }],
        }),
      }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks[0]?.source).toBe('web');
  });

  it('drops a pick that still names ActiveTO or eFun as the rec portal', () => {
    const picks = toPicks([
      {
        ...WHOLE_PICK,
        name: 'Parent-and-tot swim, Toronto Community Centre',
        source_name: 'City of Toronto ActiveTO / recreation portal',
      },
      { ...WHOLE_PICK, name: 'eFun family swim', source_name: 'eFun' },
      WHOLE_PICK,
    ]);
    expect(picks.map((p) => p.name)).toEqual([WHOLE_PICK.name]);
  });
});

describe('never a directory', () => {
  it('trims past the ceiling rather than costing the parent the good ones', async () => {
    const restore = quiet();
    const many = Array.from({ length: 5 }, (_, i) => ({ ...WHOLE_PICK, name: `Gym ${i}` }));
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(1), compose: composeResult({ picks: many }) }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks.map((p) => p.name)).toEqual(['Gym 0', 'Gym 1', 'Gym 2']);
    restore.mockRestore();
  });
});

describe('failure is named, and tried twice', () => {
  it('retries once and then names why', async () => {
    const restore = quiet();
    let calls = 0;
    const finder = createActivityFinder(
      makeClient({
        ground: () => {
          calls += 1;
          throw new Error('provider timeout');
        },
      }),
    );

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'ground_failed' });
    expect(calls).toBe(2);
    restore.mockRestore();
  });

  it('POSITIVE CONTROL - a first failure that the retry recovers still answers', async () => {
    const restore = quiet();
    let calls = 0;
    const finder = createActivityFinder(
      makeClient({
        ground: () => {
          calls += 1;
          if (calls === 1) throw new Error('provider timeout');
          return groundResult(1);
        },
        compose: composeResult({ picks: [WHOLE_PICK] }),
      }),
    );

    expect(await finder.find(QUERY)).toMatchObject({ found: true });
    restore.mockRestore();
  });

  it('does NOT retry an honest empty search', async () => {
    const restore = quiet();
    let grounds = 0;
    const finder = createActivityFinder(
      makeClient({
        ground: () => {
          grounds += 1;
          return groundResult(1);
        },
        compose: composeResult({ picks: [] }),
      }),
    );

    expect(await finder.find(QUERY)).toMatchObject({ found: false, reason: 'no_picks' });
    // One grounding plus the one read pass (needsReadPass); the whole attempt is not retried.
    expect(grounds).toBe(2);
    restore.mockRestore();
  });

  it('names a missing key rather than throwing at the caller', async () => {
    const restore = quiet();
    const finder = createActivityFinder(() => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    });

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'client_unavailable' });
    restore.mockRestore();
  });

  it('never logs the subject or the window', async () => {
    const logged: unknown[] = [];
    const restore = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => logged.push(args));
    const finder = createActivityFinder(makeClient({ ground: groundResult(0) }));

    await finder.find({ ...QUERY, subject: 'a very distinctive phrase' });
    expect(JSON.stringify(logged)).not.toContain('a very distinctive phrase');
    // POSITIVE CONTROL: it logged SOMETHING, so the assertion above is not vacuous.
    expect(JSON.stringify(logged)).toContain('not_grounded');
    restore.mockRestore();
  });
});

describe('the ground turn does not use the 50s non-stream path', () => {
  it('still returns picks when messages.create would time out on the ground phase', async () => {
    const finder = createActivityFinder(
      () =>
        ({
          messages: {
            async create(req: { tools?: { name?: string }[] }) {
              if (!isStage(req, 'activity_picks', 'picks')) {
                throw new Error('Request timed out.');
              }
              return composeResult({ picks: [WHOLE_PICK] });
            },
            stream() {
              return { finalMessage: async () => groundResult(1) };
            },
          },
        }) as unknown as AgentClient,
    );

    const found = await finder.find(QUERY);
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.picks[0]?.name).toBe(WHOLE_PICK.name);
  });
});

describe('the read pass: real search results never end empty without reading pages', () => {
  const composes = (...outs: unknown[]) => {
    let n = 0;
    return () => composeResult(outs[Math.min(n++, outs.length - 1)]);
  };
  const fetchGranted = (s: Seen) => (s.tools ?? []).some((t) => t.type === 'web_fetch_20260209');
  const grounds = (seen: Seen[]) => seen.filter((s) => s.toolChoice === 'web_search');

  it('re-grounds once with the page budget when snippets alone gave no picks', async () => {
    quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResult(30), compose: composes({ picks: [] }, { picks: [WHOLE_PICK] }) },
        seen,
      ),
    );
    const result = await finder.find(QUERY);
    expect(result.found).toBe(true);
    expect(grounds(seen).map(fetchGranted)).toEqual([false, true]);
  });

  it('pays nothing extra when the first pass already found picks (positive control)', async () => {
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(30), compose: composes({ picks: [WHOLE_PICK] }) }, seen),
    );
    expect((await finder.find(QUERY)).found).toBe(true);
    expect(grounds(seen).map(fetchGranted)).toEqual([false]);
  });

  it('ends no_picks only after pages were offered, and reads at most once', async () => {
    quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(30), compose: composes({ picks: [] }) }, seen),
    );
    expect(await finder.find(QUERY)).toMatchObject({ found: false, reason: 'no_picks' });
    expect(grounds(seen).map(fetchGranted)).toEqual([false, true]);
  });

  it('a named venue already had its page budget, so no second pass', async () => {
    quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(30), compose: composes({ picks: [] }) }, seen),
    );
    await finder.find({ ...QUERY, subject: 'Cartwheels Gym parent and tot' });
    expect(grounds(seen).map(fetchGranted)).toEqual([true]);
  });
});

describe('an empty find says what it searched', () => {
  it('returns the town and the capped research with no_picks', async () => {
    quiet();
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(5), compose: composeResult({ picks: [] }) }),
    );
    const result = await finder.find(QUERY);
    expect(result).toMatchObject({
      found: false,
      reason: 'no_picks',
      searched: { town: 'Halton Hills' },
    });
    expect(result.found === false && result.searched?.notes.length).toBeGreaterThan(0);
  });
});
