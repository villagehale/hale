import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityQuery } from './deidentify';
import { MAX_SEARCHES, composeUserMessage, createActivityFinder, groundUserMessage } from './lane';

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
  content: [{ type: 'tool_use', name: 'activity_picks', input }],
  usage: { input_tokens: 5, output_tokens: 5 },
  stop_reason: 'tool_use',
});

const WHOLE_PICK = {
  name: 'Parent & Tot Gymnastics, Halton Hills Gymnastics Centre',
  age_fit: '18 months - 3 years',
  when: 'Saturdays 9:15am, fall session from Sept 13',
  price: '$142 for 12 weeks',
  source_name: 'Halton Hills Gymnastics Centre',
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
  return () =>
    ({
      messages: {
        // biome-ignore lint/suspicious/noExplicitAny: a fake driving the request mechanics
        async create(req: any) {
          const isCompose = req.tool_choice?.name === 'activity_picks';
          seen.push({
            tools: req.tools,
            toolChoice: req.tool_choice?.name,
            userMessage: req.messages?.[0]?.content,
          });
          const pick = isCompose ? script.compose : script.ground;
          const resolved = typeof pick === 'function' ? (pick as () => unknown)() : pick;
          if (resolved instanceof Error) throw resolved;
          if (resolved === undefined) throw new Error('activity test: no script for this phase');
          return resolved;
        },
      },
    }) as unknown as AgentClient;
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('the payloads', () => {
  it('sends the de-identified query and nothing else', () => {
    expect(groundUserMessage(QUERY)).toBe(
      '{"subject":"toddler gymnastics","town":"Halton Hills","stage":"toddler","window":"this fall"}',
    );
  });

  it('omits a town and a stage it does not have rather than sending a placeholder', () => {
    expect(groundUserMessage({ subject: 'story time', window: null, town: null, stage: null })).toBe(
      '{"subject":"story time"}',
    );
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

describe('an ungrounded find never ships', () => {
  it('fails NAMED when the search returned no results, and never composes', async () => {
    const restore = quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(0), compose: composeResult({ picks: [WHOLE_PICK] }) }, seen),
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
  it('fails NAMED when the search ran but wrote no research to stand on', async () => {
    const restore = quiet();
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient(
        { ground: groundResultWithoutNotes(8), compose: composeResult({ picks: [WHOLE_PICK] }) },
        seen,
      ),
    );

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'not_grounded' });
    expect(seen.some((call) => call.toolChoice === 'activity_picks')).toBe(false);
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

  it('bounds the search spend on every attempt', async () => {
    const seen: Seen[] = [];
    const finder = createActivityFinder(
      makeClient({ ground: groundResult(2), compose: composeResult({ picks: [WHOLE_PICK] }) }, seen),
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
    ['no when', { ...WHOLE_PICK, when: '' }],
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
    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'no_picks' });
    restore.mockRestore();
  });

  it('POSITIVE CONTROL - a missing PRICE is not a reason to drop a find', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({ picks: [{ ...WHOLE_PICK, price: null }] }),
      }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks[0]).toMatchObject({
      name: WHOLE_PICK.name,
      price: null,
    });
  });

  it('keeps the whole ones and drops the broken one from the same list', async () => {
    const finder = createActivityFinder(
      makeClient({
        ground: groundResult(1),
        compose: composeResult({
          picks: [WHOLE_PICK, { ...WHOLE_PICK, name: 'Halfling', when: '' }],
        }),
      }),
    );

    const result = await finder.find(QUERY);
    expect(result.found && result.picks.map((p) => p.name)).toEqual([WHOLE_PICK.name]);
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

    expect(await finder.find(QUERY)).toEqual({ found: false, reason: 'no_picks' });
    expect(grounds).toBe(1);
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
