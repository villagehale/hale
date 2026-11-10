import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { familyLanguage } from '~/lib/channel/linq/roster-ask';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkBeyond } from '~/lib/format/link-shape';
import { voiceClient } from '~/lib/loop/voice/compose';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { CourseBindRefusal } from './prepare-reply.js';

/**
 * VIL-543 · every registration message that is not the heads-up, the evening or the
 * morning-of text. The model writes the WHOLE message from facts; code owns the facts.
 * A message that cannot be written is NOTHING SENT: there is no fallback sentence.
 */

export const REGISTRATION_NOTE_SKILL = 'registration-note';

/** A date and a clock time in the family's own zone, handed in English. */
export interface Moment {
  date: string;
  time: string;
}

interface Base {
  now: Moment;
}

export type RegistrationNoteFacts =
  | (Base &
      (
        | {
            kind: 'readiness_checklist';
            window: string;
            who: string;
            opensOn: string;
            opensAt: string;
            portal: string;
            account: string;
          }
        | { kind: 'check_in_ask'; window: string }
        | {
            kind: 'waitlist_halfway';
            town: string;
            responseHours: number | null;
            /** Where the count started: the parent's own message. Null with `deadline`. */
            clockFrom: Moment | null;
            deadline: Moment | null;
          }
        | {
            kind: 'waitlist_final';
            town: string;
            responseHours: number | null;
            /** Where the count started: the parent's own message. Null with `deadline`. */
            clockFrom: Moment | null;
            deadline: Moment | null;
            hoursLeft: number;
          }
        | { kind: 'outcome_registered'; window: string }
        | { kind: 'outcome_missed'; town: string }
        | {
            kind: 'outcome_waitlisted';
            town: string;
            position: number | null;
            responseHours: number | null;
            /** Where the count started: the parent's own message. Null with `deadline`. */
            clockFrom: Moment | null;
            deadline: Moment | null;
          }
        | { kind: 'readiness_answer'; ready: boolean; portal: string; account: string; who: string }
        | {
            kind: 'course_bound';
            replaced: boolean;
            portal: string;
            course: { name: string | null; day: string | null; time: string | null };
            ageBand: string | null;
            ageFit: 'fits' | 'outside' | null;
            who: string;
            price: string | null;
            courseCode: string | null;
            opensOn: string;
            opensAt: string;
            clockName: string;
            residentsOn: string | null;
            haleHad: Moment | null;
            regForm: boolean;
            prerequisite: boolean;
          }
        | {
            kind: 'course_link_refused';
            reason: CourseBindRefusal;
            portal: string;
            town: string;
            /** `different_season` only: the morning the page opens, and the one Hale holds. */
            pageOpens: Moment | null;
            haleHas: Moment | null;
          }
        | {
            kind: 'course_link_throttled';
            alreadyBound: boolean;
            /** Minutes until the next read is theirs. Null when the link is the one bound. */
            retryMinutes: number | null;
          }
        | {
            kind: 'approval_card';
            window: string;
            opensOn: string;
            opensAt: string;
            link: string;
            residentsFirstDays: number | null;
            who: string;
            ageBand:
              | { published: true; children: { who: string; fit: 'in_band' | 'near_band' }[] }
              | { published: false };
            texts: (
              | { text: 'week_ahead' | 'checklist'; daysBefore: number }
              | { text: 'evening_before' }
              | { text: 'just_before_open'; minutesBefore: number }
            )[];
            courseLinkTip: boolean;
          }
      ))
  /** A second parent's yes to a morning the household already approved. */
  | { kind: 'already_approved' };

export type RegistrationNoteKind = RegistrationNoteFacts['kind'];

export type RegistrationNoteInput = RegistrationNoteFacts & { language: ReplyLanguage };

/** Structural refusals only: empty, or a link that was not handed. */
export function noteRefusals(body: string, facts: RegistrationNoteFacts): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const handed = facts.kind === 'approval_card' ? [facts.link] : [];
  return hasLinkBeyond(text, handed) ? ['other_link'] : [];
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const NOTE_MAX_ATTEMPTS = 2;
export const NOTE_MAX_TOKENS = 1024;
export const NOTE_TOOL = {
  name: 'registration_note_text',
  description: 'The one registration message Hale sends the parent.',
} as const;

/** The whole message, or null after refused or failed attempts. Null sends nothing. */
export async function composeRegistrationNote(
  client: AgentClient,
  facts: RegistrationNoteInput,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_NOTE_SKILL);
  } catch (err) {
    console.error(
      { familyId, kind: facts.kind, err: err instanceof Error ? err.name : 'unknown' },
      'registration note: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= NOTE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(facts),
        toolName: NOTE_TOOL.name,
        toolDescription: NOTE_TOOL.description,
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: NOTE_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = noteRefusals(text, facts);
      if (refusals.length === 0) return text;
      console.warn(
        { familyId, kind: facts.kind, attempt, refusals },
        'registration note: draft refused',
      );
    } catch (err) {
      console.warn(
        { familyId, kind: facts.kind, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration note: compose failed',
      );
    }
  }
  console.error(
    { familyId, kind: facts.kind, outcome: 'registration_note_unwritten' },
    'registration note: nothing sent',
  );
  return null;
}

/** Facts in, the family's language looked up, one message out. Null sends nothing. */
export type RegistrationNoteWriter = (
  database: Database,
  familyId: string,
  facts: RegistrationNoteFacts,
) => Promise<string | null>;

/**
 * The production writer. A missing client is unwritten, and the miss is named
 * (rule #11): nothing is sent.
 */
export function registrationNoteWriter(
  client: AgentClient | null = voiceClient(),
): RegistrationNoteWriter {
  return async (database, familyId, facts) => {
    if (client === null) {
      console.error(
        {
          familyId,
          kind: facts.kind,
          outcome: 'registration_note_unwritten',
          reason: 'client_unavailable',
        },
        'registration note: nothing sent',
      );
      return null;
    }
    const language = await familyLanguage(database, familyId);
    return composeRegistrationNote(client, { ...facts, language }, familyId);
  };
}
