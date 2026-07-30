import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadRadarVoiceSkill } from '~/lib/cron/skill';
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

/** The whole payload — this message plus the appended watch offer — must fit two SMS
 * segments. Two is the budget the copy contract is written to; the deterministic render
 * always fits, so the fallback is never itself over budget. */
export const MAX_PAYLOAD_SEGMENTS = 2;

export interface RadarVoice {
  message: string;
}

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
 * caller falls back to the deterministic render. */
const radarVoiceSchema = z.object({ message: z.string() }).strict();

/** 'richmond_hill' → 'Richmond Hill'. The municipality enum is an internal token; the
 * town's name is the public fact a parent recognises. */
function townLabel(municipality: string): string {
  return municipality
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

/** Whether a composed message may be sent as-is: grounded, question-free, and inside
 * the segment budget once the watch offer is appended. */
export function usableRadarMessage(message: string, decision: RadarDecision): boolean {
  if (findInventedFacts(message, radarFactSlots(decision)).length > 0) return false;
  if (message.includes(WATCH_OFFER)) return false;
  return smsSegments(`${message}\n\n${WATCH_OFFER}`) <= MAX_PAYLOAD_SEGMENTS;
}

const STILL_LEARNING = "I'm still learning what's on around you - I'll have a pick for you soon.";
const NO_WINDOW = 'Nothing has a registration date coming up just yet.';

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
 * Plain ASCII on purpose: one typographic dash would flip the whole SMS to UCS-2 and
 * halve the character budget (see sms-segments.ts).
 */
export function renderRadarDeterministically(decision: RadarDecision): string {
  const blocks: string[] = [];

  const pick = decision.weekendPick;
  if (pick) {
    const where = pick.candidateRef.venueName ? ` at ${pick.candidateRef.venueName}` : '';
    const who = pick.kidNames.length > 0 ? ` for ${joinNames(pick.kidNames)}` : '';
    const why = pick.whyFacts.length > 0 ? ` (${pick.whyFacts.join(', ')})` : '';
    blocks.push(`${dayLabel(pick.day)}: ${pick.candidateRef.title}${where}${who}${why}.`);
  } else {
    blocks.push(STILL_LEARNING);
  }

  const registration = decision.registrationLine;
  if (registration) {
    const who = registration.kidNames.length > 0 ? ` for ${joinNames(registration.kidNames)}` : '';
    const resident = registration.residentNote ? ` - ${registration.residentNote}` : '';
    blocks.push(
      `${townLabel(registration.windowRef.municipality)} ${registration.windowRef.cycleLabel} registration opens ${registration.opensAtLocal}${who}${resident}.`,
    );
  } else {
    blocks.push(NO_WINDOW);
  }

  return blocks.join('\n\n');
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
