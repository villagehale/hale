import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_CACHE_TTL,
  MAX_CACHE_BREAKPOINTS,
  MIN_CACHEABLE_TOKENS_55,
  MIN_CACHEABLE_TOKENS_HAIKU,
  MIN_CACHEABLE_TOKENS_OPUS,
  MIN_CACHEABLE_TOKENS_SONNET,
  PROMPT_CACHE_LAYOUT_ENV,
  SPARSE_CACHE_TTL,
  cacheControl,
  cacheCreation1hFromUsage,
  cacheHitRate,
  cachedSystem,
  cachedSystemBlocks,
  joinedSystemText,
  layoutTools,
  promptCacheHitFromRead,
  promptCacheLayoutEnabled,
  sortByToolName,
  stablePrefixBytes,
} from './prompt-cache.js';

afterEach(() => {
  delete process.env[PROMPT_CACHE_LAYOUT_ENV];
});

const SKILL = 'You are the coach. Tools and instructions stay here.';
const EVENTS = 'Dated-event addendum.';
const DAY = 'The family-local day check.';

describe('promptCacheLayoutEnabled', () => {
  it('is off unless the env is the exact string true (no trim)', () => {
    expect(promptCacheLayoutEnabled()).toBe(false);
    process.env[PROMPT_CACHE_LAYOUT_ENV] = 'true';
    expect(promptCacheLayoutEnabled()).toBe(true);
    process.env[PROMPT_CACHE_LAYOUT_ENV] = ' true';
    expect(promptCacheLayoutEnabled()).toBe(false);
    process.env[PROMPT_CACHE_LAYOUT_ENV] = 'True';
    expect(promptCacheLayoutEnabled()).toBe(false);
  });
});

describe('cacheControl', () => {
  it('omits ttl on the 5m default and sets ttl 1h when asked', () => {
    expect(cacheControl()).toEqual({ type: 'ephemeral' });
    expect(cacheControl('5m')).toEqual({ type: 'ephemeral' });
    expect(cacheControl('1h')).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('layoutTools', () => {
  const tools = [{ name: 'zeta' }, { name: 'alpha' }, { name: 'mu' }];

  it('keeps caller order when the flag is off', () => {
    expect(layoutTools(tools).map((t) => t.name)).toEqual(['zeta', 'alpha', 'mu']);
  });

  it('sorts by name when the flag is on', () => {
    process.env[PROMPT_CACHE_LAYOUT_ENV] = 'true';
    expect(layoutTools(tools).map((t) => t.name)).toEqual(['alpha', 'mu', 'zeta']);
    expect(sortByToolName(tools).map((t) => t.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('cachedSystemBlocks', () => {
  it('wraps one body in a 5m ephemeral block', () => {
    expect(cachedSystem(SKILL)).toEqual([
      { type: 'text', text: SKILL, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('puts the 1h ttl on the coach prefix', () => {
    expect(cachedSystemBlocks(SKILL, AGENT_CACHE_TTL)).toEqual([
      { type: 'text', text: SKILL, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
  });

  it('joins multiple bodies with newlines when the flag is off, one breakpoint', () => {
    const blocks = cachedSystemBlocks([SKILL, EVENTS, DAY]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(`${SKILL}\n\n${EVENTS}\n\n${DAY}`);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('splits bodies when the flag is on, breakpoint only on the last, same model text', () => {
    process.env[PROMPT_CACHE_LAYOUT_ENV] = 'true';
    const blocks = cachedSystemBlocks([SKILL, EVENTS, DAY]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(blocks[2]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks.map((b) => b.text).join('')).toBe(`${SKILL}\n\n${EVENTS}\n\n${DAY}`);
  });

  it('puts per-turn extras after the breakpoint without changing concatenated text', () => {
    const extra = 'household-group addendum.';
    const blocks = cachedSystemBlocks(SKILL, SPARSE_CACHE_TTL, undefined, [extra]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]?.cache_control).toBeUndefined();
    expect(blocks.map((b) => b.text).join('')).toBe(joinedSystemText(SKILL, [extra]));
    expect(JSON.stringify(blocks[0])).not.toContain(extra);
  });
});

describe('prefix stability (no-cost check)', () => {
  const tools = [
    { name: 'web_search', type: 'web_search_20250305' },
    { name: 'get_child_profile' },
  ];

  it('keeps tools+system identical across different volatile user payloads', () => {
    const system = cachedSystemBlocks(SKILL, AGENT_CACHE_TTL);
    const a = stablePrefixBytes(layoutTools(tools), system);
    const b = stablePrefixBytes(layoutTools(tools), system);
    expect(a).toBe(b);
    expect(a).toContain('cache_control');
    expect(a).not.toContain('2026-11-10');
    expect(a).not.toContain('the Parkers');
  });

  it('does not put family facts or a date into the cached prefix', () => {
    const familyA = JSON.stringify({ today: '2026-11-10 (Tuesday)', kids: ['Sam'] });
    const familyB = JSON.stringify({ today: '2026-03-01 (Sunday)', kids: ['Riley'] });
    const system = cachedSystem(SKILL);
    expect(stablePrefixBytes(tools, system)).not.toContain(familyA);
    expect(stablePrefixBytes(tools, system)).not.toContain(familyB);
  });

  it('stays under the four-breakpoint cap', () => {
    process.env[PROMPT_CACHE_LAYOUT_ENV] = 'true';
    const system = cachedSystemBlocks([SKILL, EVENTS, DAY], AGENT_CACHE_TTL);
    const marks = JSON.stringify(system).match(/"cache_control"/g) ?? [];
    expect(marks.length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(marks).toHaveLength(1);
  });

  it('documents per-family minimum cacheable lengths (do not pad under them)', () => {
    expect(MIN_CACHEABLE_TOKENS_SONNET).toBe(1024);
    expect(MIN_CACHEABLE_TOKENS_OPUS).toBe(1024);
    expect(MIN_CACHEABLE_TOKENS_HAIKU).toBe(4096);
    expect(MIN_CACHEABLE_TOKENS_55).toBe(MIN_CACHEABLE_TOKENS_SONNET);
  });
});

describe('cacheHitRate', () => {
  it('is cache_read / (cache_read + cache_creation + input)', () => {
    expect(
      cacheHitRate({
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        input_tokens: 10,
      }),
    ).toBe(0.8);
    expect(cacheHitRate({ input_tokens: 0 })).toBeNull();
    expect(cacheHitRate({ cache_read_input_tokens: 0, input_tokens: 100 })).toBe(0);
  });
});

describe('cacheCreation1hFromUsage', () => {
  it('reads ephemeral_1h_input_tokens and is 0 when absent', () => {
    expect(cacheCreation1hFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 2048 } })).toBe(
      2048,
    );
    expect(cacheCreation1hFromUsage({ cache_creation_input_tokens: 100 })).toBe(0);
    expect(cacheCreation1hFromUsage(undefined)).toBe(0);
  });
});

describe('promptCacheHitFromRead', () => {
  it('is undefined when the writer did not measure the cache', () => {
    expect(promptCacheHitFromRead(undefined)).toBeUndefined();
    expect(promptCacheHitFromRead(null)).toBeUndefined();
  });

  it('is true only when any tokens were read', () => {
    expect(promptCacheHitFromRead(0)).toBe(false);
    expect(promptCacheHitFromRead(12)).toBe(true);
  });
});
