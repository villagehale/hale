import type Anthropic from '@anthropic-ai/sdk';

/**
 * Prompt-cache layout for Anthropic Messages requests.
 *
 * Wire order is tools → system → messages. A `cache_control` breakpoint on the last
 * system block covers the tool definitions and the instructions — everything that is
 * byte-identical across families and turns of a skill. Per-family and per-turn content
 * belongs after that breakpoint (the first user message, then the rolling history
 * marker in the agent loop).
 *
 * `PROMPT_CACHE_LAYOUT_ENABLED=true` (exact string, no trim) reorders tools
 * alphabetically and splits skill bodies into separate system blocks. Emitting
 * `cache_control` itself does not change model input and is unconditional.
 *
 * TTL: 5 minutes is the default (`{type:'ephemeral'}`). The coach/agent prefix uses
 * 1 hour (`ttl:'1h'`, Anthropic's extended-cache-ttl). Anthropic allows four
 * breakpoints; Hale uses at most two (stable prefix + history).
 *
 * Docs: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

/** Arm in Prod to sort tools and split skill bodies into separate system blocks. */
export const PROMPT_CACHE_LAYOUT_ENV = 'PROMPT_CACHE_LAYOUT_ENABLED';

export function promptCacheLayoutEnabled(): boolean {
  return process.env[PROMPT_CACHE_LAYOUT_ENV] === 'true';
}

export type PromptCacheTtl = '5m' | '1h';

/** Anthropic's 4-breakpoint cap. Hale uses at most 2: stable prefix + history. */
export const MAX_CACHE_BREAKPOINTS = 4;

/** Haiku 5.5 / Sonnet 5.5 / Opus 5.5 minimum cacheable prefix (Claude API). */
export const MIN_CACHEABLE_TOKENS_55 = 512;

export type PromptCacheControl = { type: 'ephemeral'; ttl?: '1h' };

/** 5m is `{type:'ephemeral'}` with no ttl field (the API default). 1h sets `ttl:'1h'`. */
export function cacheControl(ttl: PromptCacheTtl = '5m'): PromptCacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

export const AGENT_CACHE_TTL: PromptCacheTtl = '1h';
export const DEFAULT_CACHE_TTL: PromptCacheTtl = '5m';

export function sortByToolName<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** YAML/code order unless the layout flag is on, then alphabetical by `name`. */
export function layoutTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return promptCacheLayoutEnabled() ? sortByToolName(tools) : [...tools];
}

export type CachedTextBlock = {
  type: 'text';
  text: string;
  cache_control?: PromptCacheControl;
};

function markedBlock(text: string, ttl: PromptCacheTtl): CachedTextBlock {
  return { type: 'text', text, cache_control: cacheControl(ttl) };
}

/**
 * Stable prefix system blocks: skill bodies (and an optional preamble), breakpoint on
 * the last. Flag off: one concatenated block — byte-identical instructions, plus
 * `cache_control`. Flag on: one block per body so tools → system prompt → skills is
 * the layout; `\n\n` is kept between bodies so the model text is unchanged.
 */
export function cachedSystemBlocks(
  skills: string | readonly string[],
  ttl: PromptCacheTtl = '5m',
  preamble?: string,
): CachedTextBlock[] {
  const bodies = (Array.isArray(skills) ? [...skills] : [skills]).filter((s) => s.length > 0);
  const parts = preamble ? [preamble, ...bodies] : bodies;
  if (parts.length === 0) {
    throw new Error('cachedSystemBlocks: empty system');
  }
  if (!promptCacheLayoutEnabled() || parts.length === 1) {
    return [markedBlock(parts.join('\n\n'), ttl)];
  }
  return parts.map((text, i) => {
    const glued = i === parts.length - 1 ? text : `${text}\n\n`;
    return i === parts.length - 1 ? markedBlock(glued, ttl) : { type: 'text', text: glued };
  });
}

/**
 * The stable system prompt behind one ephemeral cache breakpoint. Wire order is
 * tools → system → messages, so the breakpoint caches the tool definitions and the
 * instructions together; the per-turn payload goes in the user message, after it.
 */
export function cachedSystem(
  instructions: string,
  ttl: PromptCacheTtl = '5m',
): Anthropic.TextBlockParam[] {
  return cachedSystemBlocks(instructions, ttl) as Anthropic.TextBlockParam[];
}

/** Byte-stable tools+system prefix up to and including the last cache_control. */
export function stablePrefixBytes(tools: unknown, system: unknown): string {
  return JSON.stringify({ tools: tools ?? null, system: system ?? null });
}

/**
 * Hit rate = cache_read / (cache_read + cache_creation + input). Null when the
 * denominator is zero (no usage yet).
 */
export function cacheHitRate(usage: {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  input_tokens?: number | null;
}): number | null {
  const read = usage.cache_read_input_tokens ?? 0;
  const create = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const denom = read + create + input;
  return denom === 0 ? null : read / denom;
}

/** 1h cache-write tokens from Anthropic usage (`cache_creation.ephemeral_1h_input_tokens`). */
export function cacheCreation1hFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const extra = usage as {
    cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
  };
  return extra.cache_creation?.ephemeral_1h_input_tokens ?? 0;
}
