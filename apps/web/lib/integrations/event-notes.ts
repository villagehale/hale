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
 *
 * A model failure is distinct from "unavailable": the reader returns EVENT_NOTES_FAILED so the
 * mirror can count it against the description hash and stop after EVENT_NOTES_MAX_FAILED_READS.
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

/** Hash of what the facts were read from: the title AND the description. A renamed event with
 * the same description is a different source, so its old facts are not reused (Devin #930). */
export function notesSourceHash(title: string, description: string): string {
  return createHash('sha256')
    .update(JSON.stringify([title, description]))
    .digest('hex')
    .slice(0, 32);
}

/** The pre-#930 format: description only. Read only to migrate stored notes (see
 * `migrateLegacyNotes`); never written. */
export function legacyDescriptionHash(description: string): string {
  return createHash('sha256').update(description).digest('hex').slice(0, 32);
}

/**
 * Devin #930 🔴. Notes stored under the old description-only hash, on a row whose title is
 * unchanged, are the same source: rehash them in place (facts and failure count kept, no read).
 * Anything else (new-format hash, renamed event, changed description) is returned as-is.
 */
export function migrateLegacyNotes(
  stored: FamilyEventNotes | null,
  storedTitle: string | null,
  title: string,
  description: string,
): FamilyEventNotes | null {
  if (!stored || storedTitle !== title) return stored;
  if (stored.sourceHash !== legacyDescriptionHash(description)) return stored;
  return { ...stored, sourceHash: notesSourceHash(title, description) };
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

/** A read was attempted and failed (model error, bad output). Counted per description hash. */
export const EVENT_NOTES_FAILED = 'failed' as const;
/** Failed reads of one unchanged description before the mirror stops retrying it. */
export const EVENT_NOTES_MAX_FAILED_READS = 3;

/** `null`: no read was attempted (no key, no skill); nothing is counted. */
export type EventNotesReader = (input: {
  title: string;
  description: string;
}) => Promise<FamilyEventNotes | typeof EVENT_NOTES_FAILED | null>;

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
      return toEventNotes(value, notesSourceHash(title, description));
    } catch (err) {
      console.info({ reason: 'model_failed', detail: className(err) }, 'event notes read');
      return EVENT_NOTES_FAILED;
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
    (a?.sourceHash ?? null) === (b?.sourceHash ?? null) &&
    (a?.failedReads ?? 0) === (b?.failedReads ?? 0)
  );
}

/** Per-read wall clock. A read past it counts as a failed read (capped by MAX_FAILED_READS). */
export const EVENT_NOTES_READ_TIMEOUT_MS = 20_000;
/** Reads one connector sweep may start, across every connection. */
export const EVENT_NOTES_SWEEP_MAX_READS = 24;
/** Past this much sweep time no new read starts, so later connections still sync. */
export const EVENT_NOTES_SWEEP_BUDGET_MS = 90_000;
/** Reads in flight at once inside one connection. */
export const EVENT_NOTES_CONCURRENCY = 4;

/**
 * Devin #930 🔴. Bounds a reader for one cron sweep: each read is raced against a timeout
 * (a timeout is EVENT_NOTES_FAILED, so the per-hash retry cap applies), and once the sweep has
 * started `maxReads` reads or spent `budgetMs`, further calls return null without a model call
 * (deferred: nothing counted, read again next sweep). Share ONE bounded reader across a sweep.
 */
export function boundEventNotesReader(
  reader: EventNotesReader,
  opts: {
    timeoutMs?: number;
    maxReads?: number;
    budgetMs?: number;
    now?: () => number;
  } = {},
): EventNotesReader {
  const timeoutMs = opts.timeoutMs ?? EVENT_NOTES_READ_TIMEOUT_MS;
  const maxReads = opts.maxReads ?? EVENT_NOTES_SWEEP_MAX_READS;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? EVENT_NOTES_SWEEP_BUDGET_MS);
  let started = 0;
  return async (input) => {
    if (started >= maxReads || now() >= deadline) return null;
    started += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof EVENT_NOTES_FAILED>((resolve) => {
      timer = setTimeout(() => {
        console.info({ reason: 'timeout' }, 'event notes read');
        resolve(EVENT_NOTES_FAILED);
      }, timeoutMs);
    });
    try {
      return await Promise.race([reader(input).catch(() => EVENT_NOTES_FAILED), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
