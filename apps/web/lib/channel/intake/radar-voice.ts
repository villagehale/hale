import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadRadarVoiceSkill } from '~/lib/cron/skill';
import { findBannedPhrases } from '~/lib/health/framing';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import type { ReplyLanguage } from '~/lib/channel/language';
import { townLabel } from '~/lib/channel/town-label';
import {
  type ActionLineHeld,
  type ActionMove,
  firstReplyActionLineEnabled,
  renderActionLine,
} from './action-line';
import { WATCH_OFFER } from './copy';
import type { RadarDecision, RegistrationAbsence } from './radar-decide';

/** Re-exported: a town is spelled in exactly one module (town-label.ts), and every
 * caller of the radar voice already reaches for its name here. */
export { townLabel };

/**
 * VIL-238 · M3 — COMPOSE: the decision object, said out loud in Hale's voice.
 *
 * ONE model call, and it writes only WORDS. Every fact — the title, the venue, the day,
 * the kids' names, the registration date — is injected by DECIDE, and the composed
 * message is checked back against those facts before it is allowed anywhere near a
 * parent. This is what makes fabrication impossible by construction rather than merely
 * unlikely: the model cannot invent a venue Hale never found, because a message
 * carrying one is discarded and the DETERMINISTIC render — grounded by construction —
 * goes out in its place.
 *
 * Three checks, each with a specific failure it exists to stop:
 *
 *   1. the fact lint (a time or a link the decision never contained — the two shapes
 *      that cost a parent a wasted trip);
 *   2. the watch question (the state machine appends {@link WATCH_OFFER} itself, so a
 *      composer that also asks it asks twice);
 *   3. the segment budget (this message is billed per segment, per family, and read on
 *      a phone).
 */

const VOICE_MAX_TOKENS = 300;

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
const radarVoiceSchema = z.object({ message: z.string() }).strict();

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

/** Every user-facing string in the voice, for the lint. */
export function radarVoiceStrings(voice: RadarVoice): string[] {
  return [voice.message];
}

/** Parse the model's JSON answer into a typed voice, or null when unusable. */
export function parseRadarVoiceAnswer(answer: string | null): RadarVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = radarVoiceSchema.safeParse(value);
  if (!parsed.success || parsed.data.message.trim().length === 0) return null;
  return parsed.data;
}

/**
 * WHY a composed message may not be sent as-is, or null when it may.
 *
 * One measurement, two names. The split is what the dark probe reads: "the model
 * fabricated a venue" and "the link did not fit" are opposite problems with opposite
 * fixes, and on main they shared one console.error and were indistinguishable
 * afterwards (rule #11).
 *
 * `tail` is the action line the shell is about to append. It is measured HERE and
 * nowhere else, because a budget check that measures a shorter string than the one
 * that ships is a check that passes payloads the sender then discards.
 */
export function radarMessageFault(
  message: string,
  decision: RadarDecision,
  tail: string,
): 'grounding' | 'budget' | null {
  if (findInventedFacts(message, radarFactSlots(decision)).length > 0) return 'grounding';
  // The checkpoint block is the one place a model writes health-ADMIN words, and M8's
  // whole argument for static templates was that a single invented clause there ("she's
  // a bit behind") is a diagnosis Hale has no standing to make. So the framing lint runs
  // over the composed message whenever a checkpoint is in play: a message that turns an
  // administrative window into a claim about the child, or into an instruction, is
  // discarded and the reviewed table's own wording goes out instead.
  if (decision.checkpoint !== null && findBannedPhrases(message).length > 0) return 'grounding';
  // Not arithmetic, so not 'budget': the shell appends the one question, and a composer
  // that writes it too has asked the parent twice.
  if (message.includes(WATCH_OFFER)) return 'grounding';
  if (smsSegments(`${message}${tail}\n\n${WATCH_OFFER}`) > MAX_PAYLOAD_SEGMENTS) return 'budget';
  return null;
}

/** Whether a composed message may be sent as-is: grounded, question-free, clear of
 * M8's framing line, and inside the segment budget once the action line and the watch
 * offer are appended. */
export function usableRadarMessage(
  message: string,
  decision: RadarDecision,
  tail: string,
): boolean {
  return radarMessageFault(message, decision, tail) === null;
}

const STILL_LEARNING = "I'm still learning what's on around you - I'll have a pick for you soon.";
const NO_WINDOW = 'Nothing has a registration date coming up just yet.';
/** The all-empty answer: what Hale is doing, what it does NOT have yet — said plainly,
 * because a warm line with no content in it reads as a brand and not as a neighbour —
 * and then, from {@link FIRST_FIND_BEAT}, when that changes. */
const MAPPING_NOW =
  "I'm mapping what's near you now - nothing to point you to yet, and no registration date coming up.";
/** The same opening without the registration half, for the shape that has a REASON to
 * put there instead. Spelled out rather than sliced off {@link MAPPING_NOW}: both are
 * approved copy, and one of them is pinned verbatim outside this module
 * (lib/channel/reconcile/claims.test.ts) as a sentence the ledger need not back. */
const MAPPING_ONLY = "I'm mapping what's near you now - nothing to point you to yet.";

/**
 * The between-cycles line: this town's season has gone, and the next dates are not up.
 *
 * It states two facts and promises nothing. The watch offer the state machine appends
 * carries the offer, and the commitments ledger only ever backs {@link FIRST_FIND_BEAT} —
 * so "I'll text you when they post" here would be a debt Hale recorded against nobody.
 */
function betweenCyclesLine(absence: RegistrationAbsence): string {
  const next = absence.nextCycleLabel ? `${absence.nextCycleLabel} dates` : 'the next dates';
  return `${townLabel(absence.cycleRef.municipality)} ${absence.cycleRef.cycleLabel} registration already opened ${absence.lastOpenedAtLocal} - ${next} are not posted yet.`;
}

/**
 * The same two facts as {@link betweenCyclesLine}, minus the half that is now
 * misleading. A cycle that opened five days ago is not a season that has gone, and "the
 * next dates are not posted yet" invites a parent to wait for a cycle they should be
 * registering for today.
 *
 * It claims a TOWN, a CYCLE and a DATE, and nothing else — never "there's still room"
 * and never "before it fills" (R7). Hale has not read the page; the registration layer
 * states that boundary for itself (registration/sequence/shortlist.ts).
 *
 * No trailing full stop: `lastOpenedAtLocal` already ends in "a.m."/"p.m." with its own
 * period (formatWhenPhrase, lib/format/datetime.ts).
 */
function stillOpenLine(absence: RegistrationAbsence): string {
  return `${townLabel(absence.cycleRef.municipality)} ${absence.cycleRef.cycleLabel} registration opened ${absence.lastOpenedAtLocal}`;
}

/** How many blocks the render may spend, and the same ceiling the skill is written to.
 * Not a segment budget — {@link MAX_PAYLOAD_SEGMENTS} is the arithmetic one — but the
 * copy contract: three sentences, read on a phone, one hand holding a toddler. When all
 * three rungs are filled the checkpoint is the one that yields, because a registration
 * date closes and a weekend passes while an administrative window stays open for months.
 *
 * R8a: a tail costs a block. A parent handed "Toronto Fall 2026 registration opened Sep
 * 15" AND the page has one thing to do; the Saturday storytime underneath it is noise —
 * the same one-message-one-thing discipline the decide stage already argues. */
function maxBlocks(tail: string): number {
  return tail.length > 0 ? 1 : 2;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function dayLabel(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * The grounded render: every fact from the decision, no model involved. It is what goes
 * out whenever the composed voice is unusable or unavailable — so an outage, a bad
 * answer, or a fabricated venue costs a parent WARMTH, never accuracy.
 *
 * The CASCADE, and it is the same order the skill is written to: a registration date
 * that closes beats a drop-in that repeats, and a drop-in this weekend beats an
 * administrative window that stays open for months. An absence is worth a line only
 * when Hale has nothing better to put there — which is the whole point of the third
 * rung: a family whose geography is empty now hears their child's next real checkpoint
 * instead of two apologies.
 *
 * Plain ASCII on purpose: one typographic dash would flip the whole SMS to UCS-2 and
 * halve the character budget (see sms-segments.ts).
 */
export function renderRadarDeterministically(decision: RadarDecision, tail: string): string {
  const blocks: string[] = [];

  const registration = decision.registrationLine;
  if (registration) {
    const who = registration.kidNames.length > 0 ? ` for ${joinNames(registration.kidNames)}` : '';
    const resident = registration.residentNote ? ` - ${registration.residentNote}` : '';
    blocks.push(
      `${townLabel(registration.windowRef.municipality)} ${registration.windowRef.cycleLabel} registration opens ${registration.opensAtLocal}${who}${resident}.`,
    );
  }

  const pick = decision.weekendPick;
  if (pick) {
    const where = pick.candidateRef.venueName ? ` at ${pick.candidateRef.venueName}` : '';
    const who = pick.kidNames.length > 0 ? ` for ${joinNames(pick.kidNames)}` : '';
    const why = pick.whyFacts.length > 0 ? ` (${pick.whyFacts.join(', ')})` : '';
    blocks.push(`${dayLabel(pick.day)}: ${pick.candidateRef.title}${where}${who}${why}.`);
  }

  const checkpoint = decision.checkpoint;
  if (checkpoint) {
    const who = checkpoint.kidNames.length > 0 ? `${joinNames(checkpoint.kidNames)}: ` : '';
    blocks.push(`${who}${checkpoint.task}`);
  }

  const absence = decision.registrationAbsence;
  // One sentence about this town, in whichever tense is true of it. Bound once because
  // three places below choose between the same two lines, and a fourth caller picking
  // the wrong one is how a tense comes apart.
  const absenceLine =
    absence === null ? null : absence.stillOpen ? stillOpenLine(absence) : betweenCyclesLine(absence);
  if (blocks.length === 0) {
    // Still nothing found, but the registration half is answerable: a town between
    // cycles is a different sentence from a town that has never been on the radar, and
    // it is the one the parent can act on knowing.
    // The absence LEADS when it is the only real thing known about this family: it is
    // a fact about their town, and the same cascade that puts a registration date ahead
    // of a drop-in puts it ahead of the mapping line.
    if (absenceLine !== null) {
      const lead = absenceLine;
      // R8b. This return is not sliced by maxBlocks at all — there is no block to spend
      // — so a tail costs the MAPPING_ONLY clause instead, and the worst seeded cycle
      // label stops being unsendable at 487 septets. The honest half to drop is the one
      // saying Hale has nothing to point them to: it has just pointed them at a page.
      // FIRST_FIND_BEAT stays unconditionally — `emptyHanded` is what the commitments
      // ledger keys on, and a beat dropped at render against a debt recorded at send is
      // the 2026-08-11 told-marker defect in a new costume.
      return tail.length > 0
        ? `${lead} ${FIRST_FIND_BEAT}`
        : `${lead} ${MAPPING_ONLY} ${FIRST_FIND_BEAT}`;
    }
    return `${MAPPING_NOW} ${FIRST_FIND_BEAT}`;
  }
  // One real fact, and room for the absence that matters: a family who got the pick is
  // owed the registration answer — with its reason when there is one — and everyone
  // else is owed the promise of a pick.
  if (blocks.length === 1) {
    blocks.push(pick ? (absenceLine ?? NO_WINDOW) : STILL_LEARNING);
  }
  // R8a costs a block, and R10 decides WHICH block survives it. Slicing by position
  // alone drops whatever the cascade happened to put second — and for a pick above a
  // still-open town that is the town sentence itself, silently erased by a rung that
  // did not render, which is the whole defect this rung's tense exists to avoid. The
  // block the tail is ABOUT is the registration one: a municipal page underneath a
  // Saturday storytime is two subjects in one text, and only one of them is actionable.
  if (tail.length > 0 && absenceLine !== null) return absenceLine;
  return blocks.slice(0, maxBlocks(tail)).join('\n\n');
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
  /** The composed voice lost and the deterministic render went out, with WHICH check
   *  lost it. Null when the composed message shipped. */
  voiceFallback: 'grounding' | 'budget' | 'skill_load' | 'no_client' | null;
}

/**
 * The radar message for one decision. The model composes; the checks decide whether its
 * words ship. A null client (no API key, or the voice kill switch) skips the call
 * entirely — the deterministic render is a first-class outcome here, not an error path,
 * because a parent mid-intake must get their answer whether or not a model is reachable.
 *
 * THE ACTION LINE IS APPENDED HERE, so one function owns the whole payload shape and
 * the state machine's send site has a zero-line diff. The model never sees it.
 */
export async function composeRadarMessage(
  decision: RadarDecision,
  deps: {
    familyId: string;
    database: Database;
    client: AgentClient | null;
    /** Required, never defaulted: the absence of a language is a value a caller states
     *  (rule #11). The first reply has no language of its own yet, so radar.ts says
     *  'en' out loud rather than letting a default say it silently. */
    language: ReplyLanguage;
  },
): Promise<RadarMessage> {
  const action = renderActionLine(decision, deps.language);
  const actionMove = action.line === null ? null : action.move;
  const candidate = action.line === null ? '' : `\n\n${action.line}`;

  // ORDER MATTERS, and it is the dark flag's whole point. The budget is measured FIRST,
  // against the grounded render that must always fit, so a night with the flag off says
  // how often the tail WOULD have been dropped for length. Only then is the flag read.
  let held: ActionLineHeld | null = action.line === null ? action.held : null;
  let tail = candidate;
  if (
    tail.length > 0 &&
    smsSegments(`${renderRadarDeterministically(decision, tail)}${tail}\n\n${WATCH_OFFER}`) >
      MAX_PAYLOAD_SEGMENTS
  ) {
    held = 'over_budget';
    tail = '';
  }
  if (tail.length > 0 && !firstReplyActionLineEnabled()) {
    held = 'flag_off';
    tail = '';
  }

  const deterministic = renderRadarDeterministically(decision, tail);
  const fallback = (voiceFallback: NonNullable<RadarMessage['voiceFallback']>): RadarMessage => ({
    body: `${deterministic}${tail}`,
    actionMove,
    actionHeld: held,
    voiceFallback,
  });

  if (!deps.client) return fallback('no_client');

  // The skill is loaded OUTSIDE the fallback boundary in the loop's voice callers
  // because a missing file there is a deploy bug. Here it is inside it deliberately:
  // this call sits in the middle of a stranger's first conversation, and no deploy
  // problem is worth leaving that conversation unanswered.
  let skill: Awaited<ReturnType<typeof loadRadarVoiceSkill>>;
  try {
    skill = await loadRadarVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'radar: skill load failed - deterministic render');
    return fallback('skill_load');
  }

  const { voice } = await composeVoice<RadarVoice>({
    skill,
    context: radarVoiceContext(decision),
    factSlots: radarFactSlots(decision),
    parse: parseRadarVoiceAnswer,
    voiceStrings: radarVoiceStrings,
    client: deps.client,
    database: deps.database,
    familyId: deps.familyId,
    agentName: 'radar-voice',
    traceName: 'radar-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });

  if (!voice) return fallback('grounding');
  const fault = radarMessageFault(voice.message, decision, tail);
  if (fault !== null) {
    console.error(
      { familyId: deps.familyId, fault },
      'radar: composed message failed the grounding/budget check - deterministic render',
    );
    return fallback(fault);
  }
  return { body: `${voice.message}${tail}`, actionMove, actionHeld: held, voiceFallback: null };
}
