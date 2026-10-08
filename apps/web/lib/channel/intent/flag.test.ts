import { afterEach, describe, expect, it } from 'vitest';
import { aiIntentRouterEnabled } from './flag';

describe('aiIntentRouterEnabled', () => {
  const previous = process.env.AI_INTENT_ROUTER_ENABLED;

  afterEach(() => {
    if (previous === undefined) process.env.AI_INTENT_ROUTER_ENABLED = undefined;
    else process.env.AI_INTENT_ROUTER_ENABLED = previous;
  });

  it('is off unless the value is exactly true', () => {
    expect(aiIntentRouterEnabled({})).toBe(false);
    expect(aiIntentRouterEnabled({ AI_INTENT_ROUTER_ENABLED: 'TRUE' })).toBe(false);
    expect(aiIntentRouterEnabled({ AI_INTENT_ROUTER_ENABLED: '1' })).toBe(false);
    expect(aiIntentRouterEnabled({ AI_INTENT_ROUTER_ENABLED: 'on' })).toBe(false);
    expect(aiIntentRouterEnabled({ AI_INTENT_ROUTER_ENABLED: 'true' })).toBe(true);
  });
});
