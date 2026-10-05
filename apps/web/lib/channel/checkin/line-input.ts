import type { ReplyLanguage } from '../language';
import { NO_BOOKING_CLAIM } from '../linq/group-line-input';
import type { SpokenLineInput } from '../voice/judge';

/**
 * VIL-413 / VIL-417 · what the model is handed for every word the evening check-in lane
 * says to a parent: the nightly question, the anchored "how did swim go", and the three
 * answers (a thank-you, a refusal to keep something, a cadence receipt).
 *
 * Until this change the lane was a copy file: one pinned first ask that printed LESS and
 * NO, a five-member pool, a locked anchored sentence, three cadence acks that taught
 * DAILY, a five-member thank-you pool in two languages, and a step-down notice. All of it
 * is gone. Code now supplies the facts (which kids may be named, which activity Hale saw,
 * what the cadence became and why, whether the note was kept), the judge holds the limits,
 * and the skill (packages/agent/skills/checkin-voice.md) holds the direction.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx so the real
 * request shape is judged, not a replica.
 */

export const CHECKIN_VOICE_SKILL = 'checkin-voice';

/** Two short sentences, with room for French accents. The nightly ask is read for months. */
export const CHECK_IN_MAX_CHARS = 200;

/**
 * The longest run of first names an evening question may carry. Past this the names
 * are dropped and the model says "the kids": a household of long names loses the names,
 * never the brevity — this message is sent every night.
 */
export const CHECK_IN_MAX_NAME_CHARS = 40;

/**
 * The longest calendar title the anchored question may carry. `family_events` titles are
 * freeform; one long enough to crowd the line gives up the ANCHOR rather than the budget
 * (the sweep counts it as `over_budget` and asks the day form). The judge would refuse a
 * line that ran over anyway; deciding it here means the model is never handed a fact it
 * cannot carry.
 */
export const CHECK_IN_MAX_ACTIVITY_CHARS = 60;

export type CheckInCadenceFact = 'daily' | 'weekly' | 'off';

export type CheckInLineRequest =
  /** The first evening question this household has ever been asked. */
  | { kind: 'first_ask'; kids: readonly string[] }
  /** Every evening after the first. */
  | { kind: 'later_ask'; kids: readonly string[] }
  /** Hale saw something on the calendar today and asks about it by name. */
  | { kind: 'how_it_went'; activity: string; kids: readonly string[] }
  /** The rhythm changed: the parent asked, or three quiet evenings stepped it down. */
  | { kind: 'cadence_ack'; cadence: CheckInCadenceFact; trigger: 'parent_asked' | 'quiet_evenings' }
  /** The parent told Hale about their day. `kept` is whether Hale kept it. */
  | { kind: 'noted_ack'; kept: boolean };

export type CheckInLineKind = CheckInLineRequest['kind'];

export interface CheckInLineOptions {
  /** The parent whose evening it is, named when the line lands in the household group. */
  parentName?: string | null;
  /** What the parent just wrote, when the line answers a message. */
  parentWords?: string | null;
}

/**
 * The lane's own red line: never a word to type. The judge already refuses "reply yes"
 * and compliance wording; this catches the lane's old vocabulary in any case and either
 * language ("Reply LESS", "répondez DAILY", "text NO").
 */
export const NO_KEYWORD_ASK = {
  name: 'keyword_ask',
  // Letter-aware boundary: ASCII \b never fires before "Écris".
  pattern:
    /(?<![\p{L}])(?:reply|text|answer|send|r[ée]pond(?:s|ez)|[ée]cri(?:s|vez)|tape[sz]?)\s+(?:with\s+|avec\s+)?["'«]?(?:LESS|NO|NON|DAILY|WEEKLY|NIGHTLY|YES|OUI|STOP|START)(?![\p{L}])/iu,
};

/** A quiet evening is never remarked on. */
export const NO_SCOLDING = {
  name: 'scolding',
  pattern:
    /didn'?t hear|haven'?t heard|no reply|you missed|missed you|went quiet|you('ve| have) been quiet|pas de r[ée]ponse|sans nouvelles/i,
};

/** "Noted" as an opener is on the voice rules' banned list; this lane was its last user. */
export const NO_NOTED_OPENER = {
  name: 'noted_opener',
  pattern: /^\s*(?:noted|not[ée])\b/i,
};

/** The names the question may carry, or none when they would not fit. */
export function nameableKids(kids: readonly string[]): string[] {
  const trimmed = kids.map((kid) => kid.trim()).filter((kid) => kid.length > 0);
  return trimmed.join(', ').length > CHECK_IN_MAX_NAME_CHARS ? [] : trimmed;
}

/**
 * Facts, limits, and anchors for one check-in line. The model sees facts; the judge
 * sees the rest. `address` is tu in a parent's own thread and vous in the household group,
 * where the parent is also named so both readers know whose evening it is.
 */
export function checkInLineInput(
  request: CheckInLineRequest,
  language: ReplyLanguage,
  address: 'tu' | 'vous' = 'tu',
  options: CheckInLineOptions = {},
): SpokenLineInput {
  const parentName = address === 'vous' ? options.parentName?.trim() || null : null;
  const base = {
    skill: CHECKIN_VOICE_SKILL,
    kind: request.kind,
    language,
    address,
    maxChars: CHECK_IN_MAX_CHARS,
    parentWords: options.parentWords ?? null,
  };
  const addressed = parentName ? [parentName] : [];

  switch (request.kind) {
    case 'first_ask':
    case 'later_ask': {
      const kids = nameableKids(request.kids);
      return {
        ...base,
        questions: 1,
        facts: { kids, parentName },
        mustMention: [...addressed, ...kids],
        forbidden: [NO_KEYWORD_ASK, NO_SCOLDING, NO_BOOKING_CLAIM],
      };
    }
    case 'how_it_went': {
      const kids = nameableKids(request.kids);
      return {
        ...base,
        questions: 1,
        facts: { activity: request.activity, kids, parentName },
        mustMention: [...addressed, request.activity],
        forbidden: [NO_KEYWORD_ASK, NO_SCOLDING, NO_BOOKING_CLAIM],
      };
    }
    case 'cadence_ack':
      return {
        ...base,
        questions: 0,
        facts: { cadence: request.cadence, trigger: request.trigger, parentName },
        mustMention: addressed,
        forbidden: [NO_KEYWORD_ASK, NO_SCOLDING, NO_NOTED_OPENER, NO_BOOKING_CLAIM],
      };
    case 'noted_ack':
      return {
        ...base,
        questions: 0,
        facts: { kept: request.kept, parentName },
        mustMention: addressed,
        forbidden: [NO_KEYWORD_ASK, NO_SCOLDING, NO_NOTED_OPENER, NO_BOOKING_CLAIM],
      };
  }
}
