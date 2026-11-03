import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type ProviderHealthDeps,
  claimProviderIncident,
  probeProviderHealth,
  providerPreflight,
} from './provider-health';

/**
 * VIL-552 · the 2026-10-31 usage-limit outage. The real probe classifies the SDK error,
 * the real rate_limits claim dedupes, and only the Slack sender is a counting port.
 */

const USAGE_LIMIT_TEXT =
  'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';

function usageLimitClient(): AgentClient {
  return {
    messages: {
      create: async () => {
        throw Anthropic.APIError.generate(
          400,
          { type: 'error', error: { type: 'invalid_request_error', message: USAGE_LIMIT_TEXT } },
          undefined,
          { 'request-id': 'req_probe' },
        );
      },
    },
  } as unknown as AgentClient;
}

let testDb: TestDb;

beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  await testDb.close();
});

describe('providerPreflight on a usage-limit 400', () => {
  it('aborts every window and pages #ops once per 24 h window, not once per call', async () => {
    const sent: string[] = [];
    const deps: ProviderHealthDeps = {
      probe: probeProviderHealth,
      claim: claimProviderIncident,
      sender: {
        send: async (subject) => {
          sent.push(subject);
          return true;
        },
      },
    };
    const client = usageLimitClient();
    const DAY_ONE = new Date('2026-10-31T10:00:00Z');

    const first = await providerPreflight(testDb.database, 'nudge_sweep', client, DAY_ONE, deps);
    const second = await providerPreflight(
      testDb.database,
      'memory_inference',
      client,
      DAY_ONE,
      deps,
    );
    const third = await providerPreflight(testDb.database, 'nudge_sweep', client, DAY_ONE, deps);

    expect(first).toEqual({
      proceed: false,
      abort: { failure: 'usage_limit', detail: USAGE_LIMIT_TEXT, alerted: true },
    });
    expect(second).toEqual({
      proceed: false,
      abort: { failure: 'usage_limit', detail: USAGE_LIMIT_TEXT, alerted: false },
    });
    expect(third).toEqual(second);
    expect(sent).toHaveLength(1);

    // Positive control: the next 24 h bucket is a new incident window and pages again.
    const nextDay = await providerPreflight(
      testDb.database,
      'nudge_sweep',
      client,
      new Date('2026-11-01T10:00:00Z'),
      deps,
    );
    expect(nextDay.proceed).toBe(false);
    expect(sent).toHaveLength(2);
  });
});
