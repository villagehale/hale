import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { extractTravelBooking } from './extract';

/**
 * THE MECHANICS, over a scripted client — never the judgement.
 *
 * Rule #8 splits this file from `apps/worker/evals/run-travel-extract-eval.mjs` exactly
 * where the responsibility splits. Whether the model reads "Scarborough" as Toronto is
 * the eval's job against real cached Claude; what is testable here is what the CODE does
 * with whatever comes back — and the answer has to be "fails closed, in a named
 * direction", because on a non-strict tool `required` is advisory and the model skips
 * optional attributes. Each default below is the silent outcome:
 *
 *   destination_city omitted → null → `no_destination`, nothing written
 *   child_evidence omitted   → 'none' → `no_child_evidence`, nothing written
 *   confidence omitted       → 0 → `low_confidence`, nothing written
 *
 * The last one is the one that was nearly wrong. Required, an omitted confidence is a
 * ZodError, which is `extract_failed` — a FAULT — where the rule asks for silence.
 */

const INPUT = {
  subject: 'Your itinerary for AC 704',
  from: 'Air Canada <noreply@aircanada.ca>',
  body: 'Toronto to New York, Sep 12, return Sep 15. Passengers: SARAH CHEN, MIA CHEN.',
  receivedAt: '2026-09-01T12:00:00.000Z',
  childFirstNames: ['Mia'],
};

/** A client that returns exactly the tool input it is handed — the pipeline.test.ts
 * precedent. `stop_reason` is real because `forceToolJson` reads it. */
function scriptedClient(
  input: Record<string, unknown>,
  stopReason = 'tool_use',
): { client: AgentClient; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      // biome-ignore lint/suspicious/noExplicitAny: a scripted stand-in for the model
      async create(req: any) {
        requests.push(req);
        return {
          content: [{ type: 'tool_use', name: 'travel_booking', input }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: stopReason,
        };
      },
    },
  } as unknown as AgentClient;
  return { client, requests };
}

describe('extractTravelBooking · the schema fails closed on every omission', () => {
  it('parses a complete answer through unchanged', async () => {
    const { client } = scriptedClient({
      destination_city: 'New York',
      destination_region: 'NY',
      start_date: '2026-09-12',
      end_date: '2026-09-15',
      child_evidence: 'named_traveller',
      confidence: 0.9,
    });
    const result = await extractTravelBooking(INPUT, client);
    expect(result).toMatchObject({
      destinationCity: 'New York',
      destinationRegion: 'NY',
      startDate: '2026-09-12',
      endDate: '2026-09-15',
      childEvidence: 'named_traveller',
      confidence: 0.9,
    });
  });

  it('an omitted child_evidence is "none" — never a thrown extraction', async () => {
    const { client } = scriptedClient({
      destination_city: 'New York',
      start_date: '2026-09-12',
      end_date: '2026-09-15',
      confidence: 0.9,
    });
    await expect(extractTravelBooking(INPUT, client)).resolves.toMatchObject({
      childEvidence: 'none',
    });
  });

  it('an omitted destination is null', async () => {
    const { client } = scriptedClient({ confidence: 0.9 });
    await expect(extractTravelBooking(INPUT, client)).resolves.toMatchObject({
      destinationCity: null,
      destinationRegion: null,
      startDate: null,
      endDate: null,
    });
  });

  /**
   * THE ONE THAT WAS NEARLY A FAULT. Below the floor, so it lands in `low_confidence` and
   * nothing is written — paired with the positive control that a PRESENT 0.9 is carried
   * through, because a parse that always returned 0 would satisfy the first half alone.
   */
  it('an omitted confidence is 0, which is silence rather than a failure', async () => {
    const { client } = scriptedClient({
      destination_city: 'New York',
      start_date: '2026-09-12',
      end_date: '2026-09-15',
      child_evidence: 'child_fare',
    });
    const quiet = await extractTravelBooking(INPUT, client);
    expect(quiet.confidence).toBe(0);

    const { client: sure } = scriptedClient({
      destination_city: 'New York',
      start_date: '2026-09-12',
      end_date: '2026-09-15',
      child_evidence: 'child_fare',
      confidence: 0.9,
    });
    expect((await extractTravelBooking(INPUT, sure)).confidence).toBe(0.9);
  });

  it('a truncated tool call is a throw, not an empty extraction', async () => {
    const { client } = scriptedClient({}, 'max_tokens');
    await expect(extractTravelBooking(INPUT, client)).rejects.toThrow(/max_tokens/);
  });
});

describe('extractTravelBooking · what crosses the border', () => {
  it('sends the body and the children FIRST NAMES, and no age and no id', async () => {
    const { client, requests } = scriptedClient({ confidence: 0 });
    await extractTravelBooking(
      { ...INPUT, childFirstNames: ['Mia', 'Leo'] },
      client,
    );
    const sent = requests[0] as { messages: Array<{ content: string }>; max_tokens: number };
    const payload = JSON.parse(sent.messages[0]?.content ?? '{}');
    expect(payload.household_child_first_names).toEqual(['Mia', 'Leo']);
    expect(payload.email.body).toContain('Toronto to New York');
    // NO ageInMonths and no child id, unlike the sentinel's extraction: nothing in this
    // lane dates anything against a child's age, so an age would cross the border for no
    // reader (data minimisation, one field).
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('ageInMonths');
    expect(serialised).not.toContain('age_in_months');
    expect(Object.keys(payload).sort()).toEqual([
      'email',
      'household_child_first_names',
      'received_at',
    ]);
  });

  it('holds the sentinel-proven ceiling on the same lane, not a tighter one', async () => {
    const { client, requests } = scriptedClient({ confidence: 0 });
    await extractTravelBooking(INPUT, client);
    // 1024, not 512. `max_tokens` bounds thinking PLUS the tool call on an adaptive lane,
    // and `forceToolJson` throws on a max_tokens stop with no re-ask — so a tight ceiling
    // is not a smaller answer, it is `extract_failed`.
    expect((requests[0] as { max_tokens: number }).max_tokens).toBe(1024);
  });

  it('never returns the body it was handed', async () => {
    const { client } = scriptedClient({
      destination_city: 'New York',
      start_date: '2026-09-12',
      end_date: '2026-09-15',
      child_evidence: 'named_traveller',
      confidence: 0.9,
    });
    const result = await extractTravelBooking(INPUT, client);
    expect(JSON.stringify(result)).not.toContain('Toronto to New York');
    expect(JSON.stringify(result)).not.toContain('MIA CHEN');
  });
});
