import { afterEach, describe, expect, it, vi } from 'vitest';
import { parentLineProblem, speakParentLine } from './line';

describe('speakParentLine', () => {
  const previous = process.env.AI_INTENT_ROUTER_ENABLED;

  afterEach(() => {
    if (previous === undefined) process.env.AI_INTENT_ROUTER_ENABLED = undefined;
    else process.env.AI_INTENT_ROUTER_ENABLED = previous;
    vi.restoreAllMocks();
  });

  it('returns the locked line when the flag is off and does not call the model', async () => {
    process.env.AI_INTENT_ROUTER_ENABLED = undefined;
    const compose = vi.fn();
    const spoken = await speakParentLine(
      {
        flow: 'checkin',
        facts: {},
        pendingAsk: null,
        language: 'en',
        locked: 'Reply LESS for weekly.',
      },
      { composer: { compose } },
    );
    expect(spoken).toEqual({ body: 'Reply LESS for weekly.', source: 'locked' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('sends the composed line when the flag is on', async () => {
    process.env.AI_INTENT_ROUTER_ENABLED = 'true';
    const spoken = await speakParentLine(
      {
        flow: 'checkin',
        facts: { cadence: 'weekly' },
        pendingAsk: null,
        language: 'en',
        locked: 'Reply LESS for weekly.',
      },
      {
        composer: {
          compose: async () => 'Weekly from here. Text me if you want it nightly again.',
        },
      },
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.body).toContain('Weekly');
  });

  it('retries a keyword draft, then sends nothing and pages', async () => {
    process.env.AI_INTENT_ROUTER_ENABLED = 'true';
    const page = vi.fn(async () => undefined);
    const spoken = await speakParentLine(
      {
        flow: 'checkin',
        facts: {},
        pendingAsk: null,
        language: 'en',
        locked: 'Reply LESS for weekly.',
      },
      {
        composer: { compose: async () => 'Reply YES to confirm.' },
        page,
      },
    );
    expect(spoken).toEqual({ body: null, source: 'unsent' });
    expect(page).toHaveBeenCalledOnce();
    expect(String(page.mock.calls.at(0)?.at(0))).toContain('reason=keyword_ask');
  });

  it('rejects a setup phrase', () => {
    expect(parentLineProblem('Or say set me up and I will walk you through it.', {})).toBe(
      'keyword_setup',
    );
  });
});
