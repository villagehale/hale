import { createHash } from 'node:crypto';
import { type AgentClient, pickLane } from '@hale/agent';
import type { FamilyEventNotes } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-468. THE MODEL READS PARKING AND WHAT TO BRING.
 *
 * Organizers rarely label these ("use the lot off Elm", "n'oubliez pas vos patins"), and
 * matching a word like "Parking:" in code is the keyword rule in another form. So one
 * Haiku call (`event-notes-read`, task: screen) reads the description and returns only
 * the facts it states, in its own words. No inference, no fixed copy, no length cap.
 *
 * A missing key, a missing skill, or a failed read is `null`: no notes, and the reminder
 * says nothing extra (rule #11). The raw description is never returned or stored
 * (rule #1); only the stated facts and a hash of the description, so an unchanged
 * description is never read twice.
 */

const MAX_TOKENS = 512;

export const EVENT_NOTES_TOOL = 'read_event_notes';
export const EVENT_NOTES_TOOL_DESCRIPTION =
  'Return the parking and what-to-bring facts this event description states, or empty strings.';

export const eventNotesJsonSchema = {
  type: 'object',
  properties: {
    parking: {
      type: 'string',
      description: 'Parking for this event as the description states it, or empty.',
    },
    bring: {
      type: 'string',
      description: 'What to bring for this event as the description states it, or empty.',
    },
  },
  required: ['parking', 'bring'],
} as const;

const eventNotesSchema = z.object({ parking: z.string(), bring: z.string() });

/** Same bytes the eval replays (run-event-notes-eval.mjs). */
export function eventNotesUserMessage(title: string, description: string): string {
  return JSON.stringify({ title, description });
}

export function descriptionHash(description: string): string {
  return createHash('sha256').update(description).digest('hex').slice(0, 32);
}

/** A reading becomes notes: only non-empty facts become keys. */
export function toEventNotes(
  raw: { parking: string; bring: string },
  sourceHash: string,
): FamilyEventNotes {
  const parking = raw.parking.trim();
  const bring = raw.bring.trim();
  return { ...(parking ? { parking } : {}), ...(bring ? { bring } : {}), sourceHash };
}

export type EventNotesReader = (input: {
  title: string;
  description: string;
}) => Promise<FamilyEventNotes | null>;

/** Tests and any caller without a reader. Never calls a model. */
export const eventNotesIdle: EventNotesReader = async () => null;

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

export function createEventNotesReader(client: () => AgentClient): EventNotesReader {
  return async ({ title, description }) => {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    let resolved: AgentClient;
    let skill: Awaited<ReturnType<typeof loadCronSkill>>;
    try {
      resolved = client();
      skill = await loadCronSkill('event-notes-read');
    } catch (err) {
      console.info({ reason: 'unavailable', detail: className(err) }, 'event notes read');
      return null;
    }
    try {
      const { value } = await forceToolJson({
        client: resolved,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: eventNotesUserMessage(title, description),
        toolName: EVENT_NOTES_TOOL,
        toolDescription: EVENT_NOTES_TOOL_DESCRIPTION,
        inputJsonSchema: eventNotesJsonSchema,
        schema: eventNotesSchema,
        maxTokens: MAX_TOKENS,
      });
      return toEventNotes(value, descriptionHash(description));
    } catch (err) {
      console.info({ reason: 'model_failed', detail: className(err) }, 'event notes read');
      return null;
    }
  };
}

/** Same facts: a mirror re-read with an unchanged reading is not a change. */
export function sameEventNotes(
  a: FamilyEventNotes | null | undefined,
  b: FamilyEventNotes | null | undefined,
): boolean {
  return (
    (a?.parking ?? null) === (b?.parking ?? null) &&
    (a?.bring ?? null) === (b?.bring ?? null) &&
    (a?.sourceHash ?? null) === (b?.sourceHash ?? null)
  );
}
