import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadRadarVoiceSkill } from '~/lib/cron/skill';
import { findBannedPhrases } from '~/lib/health/framing';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import { WATCH_OFFER } from './copy';
import type { RadarDecision } from './radar-decide';

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

export interface RadarVoice {
  message: string;
}

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
 * caller falls back to the deterministic render. */
const radarVoiceSchema = z.object({ message: z.string() }).strict();

/** 'richmond_hill' → 'Richmond Hill'. The municipality enum is an internal token; the
 * town's name is the public fact a parent recognises. */
export function townLabel(municipality: string): string {
  return municipality
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

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

/** Whether a composed message may be sent as-is: grounded, question-free, clear of
 * M8's framing line, and inside the segment budget once the watch offer is appended. */
export function usableRadarMessage(message: string, decision: RadarDecision): boolean {
  if (findInventedFacts(message, radarFactSlots(decision)).length > 0) return false;
  // The checkpoint block is the one place a model writes health-ADMIN words, and M8's
  // whole argument for static templates was that a single invented clause there ("she's
  // a bit behind") is a diagnosis Hale has no standing to make. So the framing lint runs
  // over the composed message whenever a checkpoint is in play: a message that turns an
  // administrative window into a claim about the child, or into an instruction, is
  // discarded and the reviewed table's own wording goes out instead.
  if (decision.checkpoint !== null && findBannedPhrases(message).length > 0) return false;
  if (message.includes(WATCH_OFFER)) return false;
  return smsSegments(`${message}\n\n${WATCH_OFFER}`) <= MAX_PAYLOAD_SEGMENTS;
}

const STILL_LEARNING = "I'm still learning what's on around you - I'll have a pick for you soon.";
const NO_WINDOW = 'Nothing has a registration date coming up just yet.';
/** The all-empty answer: what Hale is doing, what it does NOT have yet — said plainly,
 * because a warm line with no content in it reads as a brand and not as a neighbour —
 * and then, from {@link FIRST_FIND_BEAT}, when that changes. */
const MAPPING_NOW =
  "I'm mapping what's near you now - nothing to point you to yet, and no registration date coming up.";

/** How many blocks the render may spend. Two segments is the whole payload budget, the
 * watch offer takes a slice of it, and this message is read on a phone. */
const MAX_BLOCKS = 2;

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
export function renderRadarDeterministically(decision: RadarDecision): string {
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

  if (blocks.length === 0) return `${MAPPING_NOW} ${FIRST_FIND_BEAT}`;
  // One real fact, and room for the absence that matters: a family who got the pick is
  // owed the registration answer, and everyone else is owed the promise of a pick.
  if (blocks.length === 1) blocks.push(pick ? NO_WINDOW : STILL_LEARNING);
  return blocks.slice(0, MAX_BLOCKS).join('\n\n');
}

/**
 * The radar message for one decision. The model composes; the checks decide whether its
 * words ship. A null client (no API key, or the voice kill switch) skips the call
 * entirely — the deterministic render is a first-class outcome here, not an error path,
 * because a parent mid-intake must get their answer whether or not a model is reachable.
 */
export async function composeRadarMessage(
  decision: RadarDecision,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<string> {
  const deterministic = renderRadarDeterministically(decision);
  if (!deps.client) return deterministic;

  // The skill is loaded OUTSIDE the fallback boundary in the loop's voice callers
  // because a missing file there is a deploy bug. Here it is inside it deliberately:
  // this call sits in the middle of a stranger's first conversation, and no deploy
  // problem is worth leaving that conversation unanswered.
  let skill: Awaited<ReturnType<typeof loadRadarVoiceSkill>>;
  try {
    skill = await loadRadarVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'radar: skill load failed - deterministic render');
    return deterministic;
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

  if (!voice || !usableRadarMessage(voice.message, decision)) {
    if (voice) {
      console.error(
        { familyId: deps.familyId },
        'radar: composed message failed the grounding/budget check - deterministic render',
      );
    }
    return deterministic;
  }
  return voice.message;
}
