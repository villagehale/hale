import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { findInventedFacts } from '../../loop/voice/facts-lint';

/**
 * VIL-226 · the decider's and the writer's tool contracts, and the checks on what comes
 * back. Relative imports only, so the evals in apps/worker/evals load this exact file and
 * grade the model against the runtime's own schema, parse and link rule.
 */

export const DECIDER_TOOL = 'proactive_decision';
export const DECIDER_MAX_TOKENS = 600;
export const WRITER_TOOL = 'proactive_text';
export const WRITER_MAX_TOKENS = 400;

/** A word shorter than this ("the", "at") says nothing about which activity was named. */
const NAMING_WORD_MIN = 4;

/**
 * One line of text a model reads or wrote: a parent's text in the snapshot, the decider's
 * reason on a held row, the cadence note the writer reads.
 */
export const LINE_CHARS = 160;

/**
 * One text a parent reads: four of those lines. An infra bound on the writer's output,
 * not a send rule. WRITER_MAX_TOKENS bounds the tokens and the Linq door takes far more
 * than this, so the code is what keeps a model's runaway text off the phone, by name.
 */
export const TEXT_CHARS = 4 * LINE_CHARS;

/** Control and bidi-format characters, which could open a second line or reorder one. */
const UNSAFE_IN_LINE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g;

/** Free text made one bounded line before it is stored or handed to another model. */
export function boundedLine(text: string): string {
  return text.replace(UNSAFE_IN_LINE, ' ').replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS);
}

export interface ToolCandidate {
  id: string;
  what: string;
  why: string;
  sourceUrl: string | null;
  worthlessAfter: string | null;
  parentRequested: boolean;
}

export type DeciderAction = 'send_now' | 'hold' | 'drop';

export interface DeciderDecision {
  reason: string;
  action: DeciderAction;
  itemIds: string[];
  holdUntil: string | null;
  frequencyPreference: { direction: 'less' | 'more'; note: string } | null;
}

/** The reason comes first so the model commits to one before it picks an action. */
export const DECIDER_TOOL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description: 'One sentence for the audit trail: why this action, for these items.',
    },
    action: { type: 'string', enum: ['send_now', 'hold', 'drop'] },
    item_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of queued candidates from the snapshot, and only those.',
    },
    hold_until: {
      type: ['string', 'null'],
      description: 'ISO time to look again when holding; null otherwise or with no clock.',
    },
    // Two flat fields, not one nullable object: in this non-strict tool the model has
    // returned the object as a string of JSON, which no parse should guess its way back from.
    frequency_direction: {
      type: ['string', 'null'],
      enum: ['less', 'more', null],
      description: "Set only when the parent's own words asked for a different pace.",
    },
    frequency_note: {
      type: ['string', 'null'],
      description: 'With frequency_direction: what the parent said, in one line. Null otherwise.',
    },
  },
  required: ['reason', 'action', 'item_ids', 'hold_until', 'frequency_direction', 'frequency_note'],
} satisfies Anthropic.Tool.InputSchema;

const decisionSchema = z
  .object({
    reason: z.string().refine((value) => value.trim().length > 0),
    action: z.enum(['send_now', 'hold', 'drop']),
    item_ids: z.array(z.string()),
    // The parser is lenient (a trailing "(comment)" still parses), so only the instant it
    // read is kept: the row and the immutable audit trail never hold the model's own text.
    hold_until: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)))
      .transform((value) => new Date(value).toISOString())
      .nullable(),
    frequency_direction: z.enum(['less', 'more']).nullable(),
    frequency_note: z.string().nullable(),
  })
  .strict()
  .refine((value) => (value.frequency_direction === null) === (value.frequency_note === null));

export function parseDeciderDecision(value: unknown): DeciderDecision | null {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    reason: parsed.data.reason.trim(),
    action: parsed.data.action,
    itemIds: parsed.data.item_ids,
    holdUntil: parsed.data.hold_until,
    frequencyPreference:
      parsed.data.frequency_direction !== null && parsed.data.frequency_note !== null
        ? { direction: parsed.data.frequency_direction, note: parsed.data.frequency_note }
        : null,
  };
}

export const WRITER_TOOL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'The one text Hale sends for the whole batch.' },
  },
  required: ['message'],
} satisfies Anthropic.Tool.InputSchema;

const textSchema = z
  .object({ message: z.string().refine((value) => value.trim().length > 0) })
  .strict();

export type WriterSkip = 'no_client' | 'model_failed' | 'unparsed' | 'invented' | 'over_length';
export type WriterResult = { message: string } | { skipped: WriterSkip };

function slotsOf(items: readonly ToolCandidate[]): string[] {
  return items.flatMap((item) =>
    [item.what, item.why, item.sourceUrl, item.worthlessAfter].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    ),
  );
}

/** Append each activity URL the text named but did not link. */
export function withActivityLinks(message: string, items: readonly ToolCandidate[]): string {
  let next = message;
  for (const item of items) {
    if (!item.sourceUrl || next.includes(item.sourceUrl)) continue;
    const words = item.what
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= NAMING_WORD_MIN);
    if (words.length === 0) continue;
    const body = next.toLowerCase();
    if (!words.every((word) => body.includes(word))) continue;
    next = `${next} ${item.sourceUrl}`;
  }
  return next;
}

/**
 * The writer's tool input, checked and finished: one non-empty message, nothing
 * invented, the link appended for an activity it named without one, and no longer than
 * one text (`TEXT_CHARS`).
 */
export function readWriterText(value: unknown, items: readonly ToolCandidate[]): WriterResult {
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  if (findInventedFacts(message, slotsOf(items)).length > 0) return { skipped: 'invented' };
  const finished = withActivityLinks(message, items);
  if (finished.length > TEXT_CHARS) return { skipped: 'over_length' };
  return { message: finished };
}

/** The writer's user message: the chosen items, and the parent's cadence note if any. */
export function writerContext(items: readonly ToolCandidate[], cadenceNote: string | null): string {
  const note = cadenceNote ? boundedLine(cadenceNote) : '';
  return JSON.stringify({ items, ...(note ? { note } : {}) });
}
