import type { AgentClient } from '@hale/agent';
import { pickModel } from '@hale/agent';
import { z } from 'zod';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type WeeklySlot, corroborateSlot, dedupeSlots, parseHoursStrict } from './hours-text';
import { loadParseCivicHoursSkill } from './skill';

/**
 * VIL-252 · M16 · Tier ② — turning a civic venue's published schedule text into
 * structured weekly slots.
 *
 * TWO STAGES, AND THE ORDER IS THE DESIGN:
 *
 *   1. DETERMINISTIC FIRST. Toronto's open-data hours strings are regular enough
 *      to read exactly (see hours-text.ts). Where that succeeds there is no model
 *      call at all: no cost, no latency, no doubt, confidence 1. Roughly all of
 *      the current EarlyON corpus takes this path — the model is for the long
 *      tail the weekly sweep grows into (centre webpages, monthly PDF calendars,
 *      hand-written notes), not for text a regex already handles.
 *
 *   2. LLM FALLBACK, THEN CORROBORATION. When the strict parse cannot account for
 *      the whole string, the parse-civic-hours skill reads it. Whatever it returns
 *      is then checked BACK AGAINST THE SOURCE TEXT: the day must be named and the
 *      two times must appear in that day as an adjacent start/end pair. A slot
 *      that fails is dropped — not down-weighted, dropped.
 *
 * That second step is the point. A prompt can ask a model not to invent a time;
 * it cannot guarantee it. Corroboration makes an invented time structurally
 * unable to reach a parent, because a time that is not in the source cannot pass
 * a check that looks for it in the source. What the model is trusted for is
 * STRUCTURE — which day, which times pair with which — not for the facts.
 */

const MAX_TOKENS = 1024;

/** Below this a slot is never surfaced to a parent. Rows are still stored (an
 * uncertain reading is auditable and re-checkable), but the projection filters on
 * it — better silent than wrong about a time. */
export const MIN_SURFACE_CONFIDENCE = 0.7;

/** What a corroborated LLM slot is worth. Never 1: the deterministic parser earns
 * that, and a model reading that happens to agree with the source is still a
 * reading. Comfortably above MIN_SURFACE_CONFIDENCE so a clean parse surfaces. */
const CORROBORATED_LLM_CEILING = 0.9;

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const slotSchema = z.object({
  day: z.enum(DAY_NAMES),
  start: z.string(),
  end: z.string(),
  confidence: z.number().min(0).max(1),
});

const parseOutputSchema = z.object({
  slots: z.array(slotSchema),
});

/** Hand-written because this is what the MODEL sees; the Zod schema above is what
 * validates what comes back. The day list is shared so the two cannot desync. */
const parseOutputJsonSchema = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: [...DAY_NAMES] },
          start: { type: 'string', description: '24-hour HH:MM, zero-padded' },
          end: { type: 'string', description: '24-hour HH:MM, zero-padded' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['day', 'start', 'end', 'confidence'],
      },
    },
  },
  required: ['slots'],
} as const;

/** `"09:30"` → 570. Null on anything that is not a real wall-clock time. */
function hhmmToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface ParsedHours {
  slots: WeeklySlot[];
  /** 0–1, applied to every slot in this parse. */
  confidence: number;
  /** How the slots were derived, for the civic_sessions row. */
  extraction: 'structured' | 'llm';
  /** Slots the model proposed that the source text does not support. Surfaced so
   * a systematic parse failure is visible in the sweep summary instead of just
   * quietly producing fewer sessions. */
  rejected: number;
}

export interface ParseHoursDeps {
  client: AgentClient;
}

/**
 * Read weekly slots out of a venue's schedule text.
 *
 * Returns an empty slot list (never throws) when the text states no schedule —
 * that is a complete answer, and a centre with no published hours must not become
 * a centre with invented ones.
 */
export async function parseCivicHours(
  text: string,
  deps: ParseHoursDeps,
): Promise<ParsedHours> {
  const strict = parseHoursStrict(text);
  if (strict !== null) {
    return { slots: strict, confidence: 1, extraction: 'structured', rejected: 0 };
  }

  // Loaded OUTSIDE the try: a missing skill file is a deploy bug and must surface
  // as one, not degrade into "this centre publishes no hours".
  const skill = await loadParseCivicHoursSkill();

  const { value } = await forceToolJson({
    client: deps.client,
    model: pickModel(skill.meta.task),
    system: skill.instructions,
    userMessage: JSON.stringify({ schedule_text: text }),
    toolName: 'weekly_slots',
    toolDescription: 'Return the weekly opening slots stated by the schedule text.',
    inputJsonSchema: parseOutputJsonSchema,
    schema: parseOutputSchema,
    maxTokens: MAX_TOKENS,
  });

  const accepted: WeeklySlot[] = [];
  let lowest = CORROBORATED_LLM_CEILING;
  let rejected = 0;

  for (const raw of value.slots) {
    const startMinute = hhmmToMinutes(raw.start);
    const endMinute = hhmmToMinutes(raw.end);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      rejected += 1;
      continue;
    }
    const slot: WeeklySlot = {
      dayOfWeek: DAY_NAMES.indexOf(raw.day),
      startMinute,
      endMinute,
    };
    // The gate. A time the source does not contain never becomes a session.
    if (corroborateSlot(text, slot) !== 'exact') {
      rejected += 1;
      continue;
    }
    accepted.push(slot);
    lowest = Math.min(lowest, raw.confidence);
  }

  const slots = dedupeSlots(accepted);
  return {
    slots,
    // The parse is only as good as its least certain surviving slot — one shaky
    // reading in a centre's week is a reason to doubt that centre's week.
    confidence: slots.length === 0 ? 0 : Math.min(lowest, CORROBORATED_LLM_CEILING),
    extraction: 'llm',
    rejected,
  };
}
