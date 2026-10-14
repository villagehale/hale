import { townLabel } from '~/lib/channel/town-label';
import type { ActionLineHeld, ActionMove } from './action-line';
import type { RadarDecision } from './radar-decide';

/** Re-exported: a town is spelled in exactly one module (town-label.ts), and every
 * caller of the radar voice already reaches for its name here. */
export { townLabel };

/**
 * Radar facts the action line and the friend voice are handed. The old composed
 * radar message and its deterministic fallback render are gone (#868: no fixed
 * lines); the friend voice says the find in its own words.
 */

/**
 * The whole payload — this message plus the appended watch offer — must fit this many
 * SMS segments. The invariant that matters is that the DETERMINISTIC render always fits,
 * so the fallback is never itself over budget.
 *
 * Three, not two, since the onboarding script v2: {@link WATCH_OFFER} now carries the
 * privacy URL (the disclosure moved from the greeting to the consent moment), which took
 * the appended tail from 46 septets to 119 — and the richest deterministic render, a
 * weekend pick PLUS a registration line with a resident note, is 205 septets on its own.
 * That payload is 324 septets, so two segments would make the grounded fallback itself
 * unsendable. Raising the cap is arithmetic forced by the approved copy, not a licence to
 * ramble: the composed message's real discipline is the radar-voice skill's own
 * three-sentence / 250-character ceiling, which the eval gates independently.
 */
export const MAX_PAYLOAD_SEGMENTS = 3;

/**
 * The forward beat, and the reason it is a FACT rather than a phrase in the skill.
 *
 * "A day or two" is a specific, and a specific a model writes from its own head is the
 * exact shape this stage exists to stop — the fact lint has no slot to check it against
 * and a parent would act on it. It is true because the 48h sweep covers every family it
 * serves, which is something Hale knows and the model cannot, so Hale hands it over.
 */
export const FIRST_FIND_BEAT = 'Your first weekend find lands in a day or two.';

/**
 * MEM-10 · when "a day or two" runs out, and the promise is simply late.
 *
 * Three days rather than two: the 48h sweep can only reach this family in their own
 * mid-morning slot (NUDGE_SEND_HOUR_LOCAL), and a family provisioned at 11 a.m. is 47
 * hours from their first eligible slot before a single tick has been missed. A due time
 * inside Hale's own delivery mechanics would report a kept promise as broken.
 */
export const FIRST_FIND_DUE_HOURS = 72;

/**
 * Whether a message Hale is about to be held to actually made the forward promise.
 *
 * The SENTENCE is the commitment, so the sent words are what is asked — not the decision
 * that authorised it. The composed message may leave the beat out (it is handed over as
 * one fact among several), and a debt recorded for a promise nobody read would put this
 * family in the overdue column for something Hale never said.
 */
export function promisesFirstFind(message: string): boolean {
  return message.includes(FIRST_FIND_BEAT);
}

export interface RadarVoice {
  message: string;
}

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
 * caller falls back to the deterministic render. */

/** Every rung of the cascade is empty — the one shape with no family fact in it. */
function emptyHanded(decision: RadarDecision): boolean {
  return (
    decision.weekendPick === null &&
    decision.registrationLine === null &&
    decision.checkpoint === null
  );
}

/**
 * What the model is handed: the decision's FACTS, and nothing else. No candidate uuid
 * (an internal identifier has no business in a text message), no follow-up flag (that
 * is the machine's business, not the parent's). An absent block is an explicit null so
 * the skill can say the honest thing about it rather than guess it away.
 */
export function radarVoiceContext(decision: RadarDecision): unknown {
  const pick = decision.weekendPick;
  const registration = decision.registrationLine;
  return {
    // Present ONLY in the shape it is true of: a family Hale has nothing for yet is
    // owed the sweep that will find them something, and nobody else is owed a promise.
    firstFindBeat: emptyHanded(decision) ? FIRST_FIND_BEAT : null,
    weekendPick: pick
      ? {
          what: pick.candidateRef.title,
          where: pick.candidateRef.venueName,
          day: pick.day,
          kidNames: pick.kidNames,
          whyFacts: pick.whyFacts,
        }
      : null,
    registration: registration
      ? {
          town: townLabel(registration.windowRef.municipality),
          cycle: registration.windowRef.cycleLabel,
          opensAtLocal: registration.opensAtLocal,
          kidNames: registration.kidNames,
          residentNote: registration.residentNote,
          ageApproximate: registration.ageApproximate,
        }
      : null,
    // The silence with a reason in it. Present only where `registration` is null, so
    // the two can never be said in the same breath, and it carries the TOWN — which a
    // null-registration context never used to, leaving the composer unable to name the
    // place whose season had simply gone (the 2026-09-16 defect).
    registrationAbsence: decision.registrationAbsence
      ? {
          town: townLabel(decision.registrationAbsence.cycleRef.municipality),
          lastCycle: decision.registrationAbsence.cycleRef.cycleLabel,
          lastOpenedAtLocal: decision.registrationAbsence.lastOpenedAtLocal,
          nextCycle: decision.registrationAbsence.nextCycleLabel,
          // The TENSE, and the model needs it or it argues with the line beneath it:
          // the skill's instruction for a bare absence is the missed-it sentence, and
          // a composed "already opened, the next dates are not posted yet" under a link
          // to the page that is open is worse than either half alone. A boolean and
          // nothing else — the date is already above it, and the URL is the one fact
          // this stage may never be handed (R3, facts-lint.ts).
          stillOpenPage: decision.registrationAbsence.stillOpen !== null,
        }
      : null,
    // The row id stays behind with the candidate uuid: `task` is the whole fact, and it
    // is a sentence a human reviewed, so there is nothing for the model to look up.
    checkpoint: decision.checkpoint
      ? { task: decision.checkpoint.task, kidNames: decision.checkpoint.kidNames }
      : null,
    offerQuestion: decision.offerQuestion,
  };
}

/** Every renderable fact, for the invented-fact lint. */
export function radarFactSlots(decision: RadarDecision): string[] {
  const slots: string[] = [];
  const pick = decision.weekendPick;
  if (pick) {
    slots.push(pick.candidateRef.title, pick.day, ...pick.kidNames, ...pick.whyFacts);
    if (pick.candidateRef.venueName) slots.push(pick.candidateRef.venueName);
  }
  const registration = decision.registrationLine;
  if (registration) {
    slots.push(
      townLabel(registration.windowRef.municipality),
      registration.windowRef.cycleLabel,
      registration.opensAtLocal,
      ...registration.kidNames,
    );
    if (registration.residentNote) slots.push(registration.residentNote);
  }
  const absence = decision.registrationAbsence;
  if (absence) {
    slots.push(
      townLabel(absence.cycleRef.municipality),
      absence.cycleRef.cycleLabel,
      absence.lastOpenedAtLocal,
    );
    if (absence.nextCycleLabel) slots.push(absence.nextCycleLabel);
  }
  const checkpoint = decision.checkpoint;
  if (checkpoint) slots.push(checkpoint.task, ...checkpoint.kidNames);
  if (emptyHanded(decision)) slots.push(FIRST_FIND_BEAT);
  return slots;
}

/**
 * What one radar turn produced, so the dark probe can read a night of real intakes
 * before one parent ever sees a URL (rule #11).
 */
export interface RadarMessage {
  /** The whole payload minus the watch offer the state machine appends. */
  body: string;
  /** The move the action line COMPUTED, whether or not it rode. Null when nothing in
   *  the decision implied one, or the line could not be built at all. */
  actionMove: ActionMove | null;
  /**
   * Why the computed line did NOT ride, or null when it did.
   *
   * A non-null `actionHeld` WITH a non-null `actionMove` is the compute-and-hold state:
   * the line was built and the budget or the flag stopped it, which is exactly what the
   * dark night is for. The brief asked for "exactly one of the two non-null"; that
   * cannot also satisfy "the would-be move is logged while the flag is off", and the
   * founder decision asked for the second. So the pair is read together.
   */
  actionHeld: ActionLineHeld | null;
  /**
   * The composed voice lost and the deterministic render went out, with WHICH check
   * lost it. Null when the composed message shipped.
   *
   * 'grounding' means the model's ANSWER was wrong — a fabricated fact or an answer
   * that would not parse. An outage is 'voice_unavailable' and never 'grounding':
   * "the model made something up" and "the call did not come back" are opposite
   * problems with opposite fixes, and a probe that folds one into the other reads its
   * own numbers backwards (rule #11).
   */
  voiceFallback: 'grounding' | 'voice_unavailable' | 'budget' | 'skill_load' | 'no_client' | null;
}
