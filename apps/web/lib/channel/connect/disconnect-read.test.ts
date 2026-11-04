import { describe, expect, it } from 'vitest';
import { matchConnectorDisconnectRequest } from './detect';
import { DISCONNECT_READ_TOOL_SCHEMA, acceptDisconnectReading } from './disconnect-read';

describe('the connector-disconnect-read eval reads only turns the pre-filter passes', () => {
  it('every fixture reaches the reader in production', async () => {
    const path = '../../../../worker/evals/connector-disconnect-read-fixtures.mjs';
    const { CONNECTOR_DISCONNECT_READ_FIXTURES: fixtures } = (await import(
      /* @vite-ignore */ path
    )) as {
      CONNECTOR_DISCONNECT_READ_FIXTURES: Array<{ id: string; text: string; expect: string }>;
    };
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures) {
      expect(matchConnectorDisconnectRequest(fixture.text), fixture.id).not.toBeNull();
    }
    // Both the two question shapes that would otherwise revoke, and real instructions.
    expect(new Set(fixtures.map((fixture) => fixture.expect))).toEqual(
      new Set(['disconnect', 'question', 'other']),
    );
  });
});

/**
 * The structural half of the disconnect read. What a text MEANS is the model's, pinned
 * by the connector-disconnect-read eval; this pins only that code keeps nothing but the
 * three readings it acts on, and that the reason is asked for before the verdict.
 */
describe('acceptDisconnectReading', () => {
  it.each(['disconnect', 'question', 'other'] as const)('keeps %s', (reading) => {
    expect(acceptDisconnectReading({ reason: 'r', reading })).toBe(reading);
  });

  it('drops a reading outside the three', () => {
    expect(acceptDisconnectReading({ reason: 'r', reading: 'revoke_everything' })).toBeNull();
  });

  it('asks for the reason before the reading', () => {
    expect(Object.keys(DISCONNECT_READ_TOOL_SCHEMA.properties)).toEqual(['reason', 'reading']);
    expect(DISCONNECT_READ_TOOL_SCHEMA.required).toEqual(['reason', 'reading']);
  });
});
