import { z } from 'zod';

/**
 * What a watch run returns. Every field is data the reply model reads later; none of
 * it is ever sent to a parent as written. Page text is untrusted, so strings are
 * length-capped and the item list is bounded.
 */
export const WATCH_ITEM_STATUSES = [
  'open',
  'full',
  'waitlist',
  'not_yet_open',
  'closed',
  'unknown',
] as const;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const BROWSER_USE_WATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['page_reached', 'script_saved', 'items'],
  properties: {
    page_reached: { type: 'boolean' },
    script_saved: { type: 'boolean' },
    fetched_at: nullableString,
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'status'],
        properties: {
          title: { type: 'string' },
          ages: nullableString,
          days_times: nullableString,
          starts_on: nullableString,
          location: nullableString,
          status: { type: 'string', enum: [...WATCH_ITEM_STATUSES] },
          spots_left: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          registration_opens: nullableString,
        },
      },
    },
  },
};

export const WATCH_MAX_ITEMS = 25;
const MAX_TEXT = 200;

const text = z
  .string()
  .transform((value) => value.trim().slice(0, MAX_TEXT))
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

const item = z.object({
  title: z.string().transform((value) => value.trim().slice(0, MAX_TEXT)),
  ages: text,
  days_times: text,
  starts_on: text,
  location: text,
  status: z.enum(WATCH_ITEM_STATUSES),
  spots_left: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  registration_opens: text,
});

const output = z.object({
  page_reached: z.boolean(),
  script_saved: z.boolean(),
  fetched_at: text,
  items: z.array(z.unknown()),
});

export type WatchItem = z.infer<typeof item>;
export interface WatchOutput {
  pageReached: boolean;
  scriptSaved: boolean;
  fetchedAt: string | null;
  items: WatchItem[];
}

/** Null when the run's output is not the shape asked for. Malformed items are
 * dropped one by one rather than failing the whole reading. */
export function parseWatchOutput(raw: unknown): WatchOutput | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = output.safeParse(value);
  if (!parsed.success) return null;
  const items: WatchItem[] = [];
  for (const candidate of parsed.data.items) {
    const one = item.safeParse(candidate);
    if (one.success && one.data.title) items.push(one.data);
    if (items.length >= WATCH_MAX_ITEMS) break;
  }
  return {
    pageReached: parsed.data.page_reached,
    scriptSaved: parsed.data.script_saved,
    fetchedAt: parsed.data.fetched_at,
    items,
  };
}
