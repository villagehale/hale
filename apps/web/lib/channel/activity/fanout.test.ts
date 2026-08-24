import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityQuery } from './deidentify';
import {
  type AngleLeg,
  type DeepAngle,
  MAX_ANGLE_FETCHES,
  MAX_ANGLE_SEARCHES,
  MAX_PAGE_NOTE_CHARS,
  angleUserMessage,
  createAngleResearcher,
  runFanOut,
} from './fanout';

/**
 * THE FAN-OUT, tested for the property it exists for: A LEG IS NOT THE RUN.
 *
 * The single-leg pass had one failure mode and it was total — a refused fetch, a
 * timed-out turn, and the whole promise came back with nothing. Three legs only help if
 * each one can fall over on its own, so every case here breaks one leg and asserts the
 * others still came home.
 */

const QUERY: ActivityQuery = {
  subject: 'Cartwheels Gym Centre fall schedule',
  town: 'Halton Hills',
  stage: 'toddler',
  window: 'this fall',
};

const NOW = new Date('2026-08-24T18:00:00.000Z');

function searchHit() {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtu_1',
    content: [
      {
        type: 'web_search_result',
        url: 'https://venue.example/programs',
        title: 'Programs',
        encrypted_content: 'x',
        page_age: null,
      },
    ],
  };
}

function fetched(url: string, text: string) {
  return {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtu_2',
    content: {
      type: 'web_fetch_result',
      url,
      retrieved_at: NOW.toISOString(),
      content: { type: 'document', source: { type: 'text', data: text } },
    },
  };
}

function refused() {
  return {
    type: 'web_fetch_tool_result',
    tool_use_id: 'srvtu_3',
    content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' },
  };
}

/** A client whose answer depends on the ANGLE in the payload, so one leg can be broken
 * while the others work. */
function clientByAngle(script: Partial<Record<DeepAngle, { content: unknown[] } | Error>>): {
  client: () => AgentClient;
  payloads: string[];
} {
  const payloads: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: a fixture standing in for the web
  const turn = async (req: any) => {
    const message = req.messages?.[0]?.content as string;
    payloads.push(message);
    const angle = (JSON.parse(message) as { angle: DeepAngle }).angle;
    const scripted = script[angle];
    if (scripted instanceof Error) throw scripted;
    return {
      content: scripted?.content ?? [searchHit()],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: 'end_turn',
    };
  };
  const client = () =>
    ({
      // biome-ignore lint/suspicious/noExplicitAny: a fixture standing in for the web
      messages: { stream: (req: any) => ({ finalMessage: () => turn(req) }) },
    }) as unknown as AgentClient;
  return { client, payloads };
}

function legBy(legs: readonly AngleLeg[], angle: DeepAngle): AngleLeg {
  const leg = legs.find((candidate) => candidate.angle === angle);
  if (!leg) throw new Error(`no ${angle} leg`);
  return leg;
}

describe('angleUserMessage', () => {
  it('carries the angle and the de-identified query, and nothing else', () => {
    const payload = JSON.parse(angleUserMessage(QUERY, 'municipal'));

    expect(payload).toEqual({
      mode: 'deep_research',
      angle: 'municipal',
      subject: 'Cartwheels Gym Centre fall schedule',
      town: 'Halton Hills',
      stage: 'toddler',
      window: 'this fall',
    });
  });
});

describe('runFanOut', () => {
  it('runs every angle and keeps the two that worked when one leg throws', async () => {
    const { client, payloads } = clientByAngle({
      municipal: new Error('Request timed out.'),
      venue_site: {
        content: [searchHit(), fetched('https://venue.example/programs', 'Sundays 9:30')],
      },
      registration: {
        content: [searchHit(), fetched('https://town.example/register', 'Opens Sept 1')],
      },
    });

    const result = await runFanOut(
      createAngleResearcher(client, () => NOW),
      QUERY,
    );

    expect(payloads).toHaveLength(3);
    expect(result.legsRead).toBe(2);
    expect(result.legsFailed).toBe(1);
    expect(legBy(result.legs, 'municipal').status).toBe('failed');
    expect(legBy(result.legs, 'municipal').reason).toContain('research_failed');
    // The two that worked still carry their pages - a failed leg costs its own evidence
    // and nothing else.
    expect(legBy(result.legs, 'venue_site').pages).toEqual([
      { url: 'https://venue.example/programs', text: 'Sundays 9:30' },
    ]);
    expect(result.pagesRead).toBe(2);
  });

  it('calls every angle CONCURRENTLY, so the wall clock is the slowest leg', async () => {
    const started: number[] = [];
    let resolveAll: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveAll = resolve;
    });
    const researcher = {
      async research(_query: ActivityQuery, angle: DeepAngle): Promise<AngleLeg> {
        started.push(Date.now());
        // Every leg blocks until all three have STARTED. A sequential fan-out deadlocks
        // here; a concurrent one sails through.
        if (started.length === 3) resolveAll?.();
        await gate;
        return {
          angle,
          status: 'read',
          searchResults: 1,
          pagesRead: 1,
          pagesStale: 0,
          pagesRefused: 0,
          pages: [],
          notes: '',
          pagesTruncated: 0,
          reason: null,
        };
      },
    };

    const result = await runFanOut(researcher, QUERY);

    expect(result.legsRead).toBe(3);
  });

  it('marks a leg that searched and opened nothing UNREAD, never failed', async () => {
    const { client } = clientByAngle({
      venue_site: { content: [searchHit(), refused(), refused()] },
    });

    const result = await runFanOut(
      createAngleResearcher(client, () => NOW),
      QUERY,
      ['venue_site'],
    );

    const leg = legBy(result.legs, 'venue_site');
    expect(leg.status).toBe('unread');
    expect(leg.pagesRefused).toBe(2);
    expect(result.legsFailed).toBe(0);
  });

  it('fails a leg that never searched at all rather than reporting an empty read', async () => {
    const { client } = clientByAngle({
      venue_site: { content: [{ type: 'text', text: 'I think there is a gym in town.' }] },
    });

    const result = await runFanOut(
      createAngleResearcher(client, () => NOW),
      QUERY,
      ['venue_site'],
    );

    expect(legBy(result.legs, 'venue_site').status).toBe('failed');
    expect(legBy(result.legs, 'venue_site').reason).toContain('not_grounded');
  });

  it('bounds a huge page and COUNTS the cut, so a base64 PDF cannot swallow the merge', async () => {
    const huge = 'A'.repeat(MAX_PAGE_NOTE_CHARS + 5_000);
    const { client } = clientByAngle({
      venue_site: { content: [searchHit(), fetched('https://venue.example/fees.pdf', huge)] },
    });

    const result = await runFanOut(
      createAngleResearcher(client, () => NOW),
      QUERY,
      ['venue_site'],
    );

    const leg = legBy(result.legs, 'venue_site');
    expect(leg.pages[0]?.text).toHaveLength(MAX_PAGE_NOTE_CHARS);
    expect(leg.pagesTruncated).toBe(1);
    // The notes the synthesis reads are rebuilt off the BOUNDED text, so the string it
    // sees and the pages the refutation checks can never disagree.
    expect(leg.notes).toContain("--- page: https://venue.example/fees.pdf ---");
    expect(leg.notes.length).toBeLessThan(huge.length);
  });

  it('holds each leg to its own small search and fetch budget', async () => {
    const requests: unknown[] = [];
    const client = () =>
      ({
        messages: {
          // biome-ignore lint/suspicious/noExplicitAny: a fixture standing in for the web
          stream: (req: any) => {
            requests.push(req);
            return {
              finalMessage: async () => ({
                content: [searchHit()],
                usage: { input_tokens: 1, output_tokens: 1 },
                stop_reason: 'end_turn',
              }),
            };
          },
        },
      }) as unknown as AgentClient;

    await runFanOut(
      createAngleResearcher(client, () => NOW),
      QUERY,
      ['venue_site'],
    );

    const tools = (requests[0] as { tools: Array<{ name: string; max_uses: number }> }).tools;
    expect(tools.find((tool) => tool.name === 'web_search')?.max_uses).toBe(MAX_ANGLE_SEARCHES);
    expect(tools.find((tool) => tool.name === 'web_fetch')?.max_uses).toBe(MAX_ANGLE_FETCHES);
  });

  it('turns a rejected leg into a reported outcome rather than an exception', async () => {
    const researcher = {
      research: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const result = await runFanOut(researcher, QUERY, ['municipal']);

    expect(result.legsFailed).toBe(1);
    expect(legBy(result.legs, 'municipal').reason).toContain('threw');
  });
});
