import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadReminderVoiceSkill } from '~/lib/cron/skill';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, localTimeLabel } from '~/lib/loop/templates/reminder/core';
import type {
  ReminderChild,
  ReminderEventView,
  ReminderVoice,
} from '~/lib/loop/templates/reminder/payload';
import { type ComposedVoice, composeVoice, firstJsonObject } from './compose';

/**
 * VIL-229 · the reminder voice — one short human line composed at FIRE time, over the
 * SAME redacted view the template renders. Rule #1: `eventDescriptor` is the exact,
 * pure function `templates/reminder/email.ts` calls at render — this module calls it
 * too (over the parent's resolved child_name_level), so the model sees no more than
 * the email will ever show, and a teen/sensitive event stays the bare generic.
 *
 * Composed per FIRING BATCH (a single event, or a shared evening) — never at the
 * hourly converge sweep, so the line reflects the actual events about to send.
 */

const VOICE_MAX_TOKENS = 150;

/** The redacted view handed to the model: every event's already-redacted descriptor
 * (teen/sensitive → the bare generic, never a name) + its resolved time label — no
 * more than the email will show (rule #1). */
export function reminderVoiceContext(
  events: readonly ReminderEventView[],
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  timeZone: string,
  offset: '-P1D' | '-PT1H',
  now: Date,
): { offset: '-P1D' | '-PT1H'; events: Array<{ what: string; when: string }> } {
  return {
    offset,
    events: events.map((event) => ({
      what: eventDescriptor(event, children, level, now),
      when: localTimeLabel(event.startsAt, timeZone),
    })),
  };
}

/** The injected fact slots the lint grounds the voice against: every event's redacted
 * descriptor + its time label. A voice string carrying a time absent from these is a
 * fabrication → degrade (the reminder never carries a link, so any URL degrades too). */
export function reminderVoiceFactSlots(
  events: readonly ReminderEventView[],
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  timeZone: string,
  now: Date,
): string[] {
  const slots: string[] = [];
  for (const event of events) {
    slots.push(eventDescriptor(event, children, level, now));
    slots.push(localTimeLabel(event.startsAt, timeZone));
  }
  return slots;
}

// Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
// caller falls back to the deterministic line.
const reminderVoiceSchema = z.object({ line: z.string() }).strict();

/** Parse the model's JSON answer into a typed ReminderVoice, or null when unusable. */
export function parseReminderVoiceAnswer(answer: string | null): ReminderVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = reminderVoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every user-facing string in the voice, for the invented-fact lint. */
export function reminderVoiceStrings(voice: ReminderVoice): string[] {
  return [voice.line];
}

/**
 * Compose the reminder voice for one firing batch, or degrade to null. Fail-open
 * (rule #8): an empty batch, a missing skill, a broken answer, an invented fact, or a
 * failed call all return `{ voice: null }` and log — the deterministic time + event
 * still render and the reminder still sends, never blocked on model availability.
 */
export async function composeReminderVoice(
  events: readonly ReminderEventView[],
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  timeZone: string,
  offset: '-P1D' | '-PT1H',
  familyId: string,
  db: Database,
  client: AgentClient,
  now: Date = new Date(),
): Promise<ComposedVoice<ReminderVoice>> {
  // A batch always has ≥1 event in practice; guarded for the same reason week-voice
  // guards an empty item list — nothing to voice, not a failure.
  if (events.length === 0) return { voice: null, degraded: false };

  let skill: Awaited<ReturnType<typeof loadReminderVoiceSkill>>;
  try {
    skill = await loadReminderVoiceSkill();
  } catch (err) {
    console.error(
      { err, familyId, voice: 'reminder-voice' },
      'voice: reminder-voice skill load failed — deterministic line',
    );
    return { voice: null, degraded: true };
  }

  return composeVoice<ReminderVoice>({
    skill,
    context: reminderVoiceContext(events, children, level, timeZone, offset, now),
    factSlots: reminderVoiceFactSlots(events, children, level, timeZone, now),
    parse: parseReminderVoiceAnswer,
    voiceStrings: reminderVoiceStrings,
    client,
    database: db,
    familyId,
    agentName: 'reminder-voice',
    traceName: 'reminder-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });
}
