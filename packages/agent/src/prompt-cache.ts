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
 * TTL: 5 minutes is the default (`{type:'ephemeral'}`). The coach/agent prefix and
 * sparse cron composers (classifier, drafter, reviewer, reminder, notices, plan)
 * use 1 hour (`ttl:'1h'`, Anthropic's extended-cache-ttl). Anthropic allows four
 * breakpoints; Hale uses at most two (stable prefix + history).
 *
 * Minimum cacheable prefix (Anthropic, Claude 4.5 / 4.6 / 5.5): 1024 tokens for
 * Sonnet and Opus, 4096 for Haiku 4.5. A shorter prefix is a silent no-op — do
 * not pad; padding would change model input. Tools count toward the prefix.
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

/** Sonnet 4.5 / 4.6 / 5.5 and Opus 4.5 / 4.6 / 5.5 minimum cacheable prefix. */
export const MIN_CACHEABLE_TOKENS_SONNET = 1024;
export const MIN_CACHEABLE_TOKENS_OPUS = 1024;
/**
 * Haiku 4.5 is 4096. Short speak/screen skills sit under this even with their
 * tool schema; Anthropic no-ops the breakpoint rather than erroring. Do not pad.
 */
export const MIN_CACHEABLE_TOKENS_HAIKU = 4096;
/** @deprecated Use the per-family constants. Kept as the Sonnet/Opus floor. */
export const MIN_CACHEABLE_TOKENS_55 = MIN_CACHEABLE_TOKENS_SONNET;

export type PromptCacheControl = { type: 'ephemeral'; ttl?: '1h' };

/** 5m is `{type:'ephemeral'}` with no ttl field (the API default). 1h sets `ttl:'1h'`. */
export function cacheControl(ttl: PromptCacheTtl = '5m'): PromptCacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

export const AGENT_CACHE_TTL: PromptCacheTtl = '1h';
/** Sparse / gappy call sites (classifier waves, evening reminder cron, notices). */
export const SPARSE_CACHE_TTL: PromptCacheTtl = '1h';
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

/** Concatenated model text of a prefix plus after-breakpoint extras. */
export function joinedSystemText(
  skills: string | readonly string[],
  extras: readonly string[] = [],
): string {
  const bodies = (Array.isArray(skills) ? [...skills] : [skills]).filter((s) => s.length > 0);
  return [...bodies, ...extras.filter((s) => s.length > 0)].join('\n\n');
}

/**
 * Stable prefix system blocks: skill bodies (and an optional preamble), breakpoint on
 * the last prefix block. `extras` ride AFTER the breakpoint (per-family / per-turn
 * addendums) so they do not bust the cached prefix. Concatenated model text is
 * unchanged (`joinedSystemText`).
 *
 * Flag off: one concatenated prefix block plus extras as uncached blocks.
 * Flag on: one prefix block per body so tools → system prompt → skills is the
 * layout; `\n\n` is kept between bodies so the model text is unchanged.
 */
export function cachedSystemBlocks(
  skills: string | readonly string[],
  ttl: PromptCacheTtl = '5m',
  preamble?: string,
  extras: readonly string[] = [],
): CachedTextBlock[] {
  const bodies = (Array.isArray(skills) ? [...skills] : [skills]).filter((s) => s.length > 0);
  const parts = preamble ? [preamble, ...bodies] : bodies;
  const extraParts = extras.filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error('cachedSystemBlocks: empty system');
  }
  const glueAfterPrefix = extraParts.length > 0;
  let prefixBlocks: CachedTextBlock[];
  if (!promptCacheLayoutEnabled() || parts.length === 1) {
    prefixBlocks = [markedBlock(parts.join('\n\n') + (glueAfterPrefix ? '\n\n' : ''), ttl)];
  } else {
    prefixBlocks = parts.map((text, i) => {
      const isLast = i === parts.length - 1;
      const glued = isLast && !glueAfterPrefix ? text : `${text}\n\n`;
      return isLast ? markedBlock(glued, ttl) : { type: 'text', text: glued };
    });
  }
  const extraBlocks: CachedTextBlock[] = extraParts.map((text, i) => ({
    type: 'text',
    text: i === extraParts.length - 1 ? text : `${text}\n\n`,
  }));
  return [...prefixBlocks, ...extraBlocks];
}

/**
 * The stable system prompt behind one ephemeral cache breakpoint. Wire order is
 * tools → system → messages, so the breakpoint caches the tool definitions and the
 * instructions together; the per-turn payload goes in the user message, after it.
 */
export function cachedSystem(
  instructions: string,
  ttl: PromptCacheTtl = '5m',
  extras: readonly string[] = [],
): Anthropic.TextBlockParam[] {
  return cachedSystemBlocks(instructions, ttl, undefined, extras) as Anthropic.TextBlockParam[];
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

/** True when this call read the prompt cache. Undefined when the writer did not measure it. */
export function promptCacheHitFromRead(
  cacheReadTokens: number | undefined | null,
): boolean | undefined {
  if (cacheReadTokens == null) return undefined;
  return cacheReadTokens > 0;
}
