import { beforeAll, describe, expect, it, vi } from 'vitest';

const traced = vi.hoisted(() => [] as Array<{ stage?: string }>);
vi.mock('../analytics/llm-trace', () => ({
  traceAnthropic: (client: unknown, trace: { stage?: string }) => {
    traced.push(trace);
    return client;
  },
}));

/** The PostHog stage label is fixed when a client is built, so it is asserted at the factory. */
describe('activity client stage labels', () => {
  // vitest.setup.ts already loads client.ts through the intake graph, so re-import it
  // fresh for the mock above to reach it.
  let client: typeof import('./client');
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY ??= 'test-key-not-used-no-request-is-made';
    vi.resetModules();
    client = await import('./client');
  });

  it("labels discovery's client 'discovery' with the activity budget", () => {
    traced.length = 0;
    const built = client.discoveryActivityClient() as unknown as {
      timeout: number;
      maxRetries: number;
    };
    expect(traced).toEqual([{ stage: 'discovery' }]);
    expect(built.timeout).toBe(client.ACTIVITY_CLIENT_OPTIONS.timeout);
    expect(built.maxRetries).toBe(client.ACTIVITY_CLIENT_OPTIONS.maxRetries);
  });

  it('leaves the SMS activity lane client unlabeled and separate', () => {
    traced.length = 0;
    const lane = client.activityClient();
    expect(traced).toEqual([{}]);
    expect(lane).not.toBe(client.discoveryActivityClient());
  });
});
