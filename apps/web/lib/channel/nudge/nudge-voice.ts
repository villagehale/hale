import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadNudgeVoiceSkill } from '~/lib/cron/skill';
import { renderHealthNudge } from '~/lib/health/copy';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import type {
  EmptySaturdayNudge,
  HealthCheckpointNudge,
  Nudge,
  WeekdayCareAsk,
} from './nudge-decide';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from './shell';

/**
 * VIL-239 · M4 — COMPOSE: the decision object, said out loud in Hale's voice.
 *
 * ONE model call, and it writes only WORDS. Every fact — the town, the open time, the
 * venue, the day, the kids' names, the weather claim — is injected by DECIDE, and the
 * composed message is checked back against those facts before it is allowed near a
 * parent. The model cannot invent a venue Hale never found, because a message carrying
 * one is discarded and the DETERMINISTIC render goes out in its place.
 *
 * The one addition over M3's shape, and it is the reason this file is not just a copy:
 * this message is UNSOLICITED. {@link NUDGE_OPT_OUT} is not the model's to write — a
 * composed message that includes it is rejected. The sender no longer appends it
 * (founder decision, 2026-10-01).
 */

const VOICE_MAX_TOKENS = 300;

// Re-exported so every existing importer keeps its import path: these moved to ./shell
// only to break the cycle between this file and the static health renderer.
export { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT };

export interface NudgeVoice {
  message: string;
}

/**
 * The nudge kinds a MODEL may write words for. Health-admin checkpoints (VIL-243 · M8)
 * are excluded by construction rather than by a runtime check: their copy is static so
 * a human can review once and know what every family receives, and excluding them from
 * this type means a future voice path cannot quietly start composing them.
 *
 * VIL-360's weekday-care ASK is excluded for the sharper version of that reason. It
 * opens a standing question whose answer is read by a deterministic grammar and written
 * as a durable fact, so the exact words have to be the ones that grammar was written
 * against — and this skill's own contract forbids it anyway ("Never write a question").
 * The weekday FIND is voiced like any other offer; it asks nothing.
 */
export type VoicedNudge = Exclude<Nudge, HealthCheckpointNudge | WeekdayCareAsk>;

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
 * caller falls back to the deterministic render. */
const nudgeVoiceSchema = z.object({ message: z.string() }).strict();

/**
 * What the model is handed: the nudge's FACTS, and nothing else. No candidate uuid, no
 * internal municipality token. `kind` rides along because the two shapes want
 * different emphasis — a deadline is urgent, a weekend swap is an offer — and the
 * skill needs to know which one it is holding.
 */
export function nudgeVoiceContext(nudge: VoicedNudge): unknown {
  if (nudge.kind === 'registration') {
    return {
      kind: nudge.kind,
      town: townLabel(nudge.windowRef.municipality),
      cycle: nudge.windowRef.cycleLabel,
      opensAtLocal: nudge.opensAtLocal,
      kidNames: nudge.kidNames,
      residentNote: nudge.residentNote,
      ageApproximate: nudge.ageApproximate,
    };
  }
  if (nudge.kind === 'empty_saturday') {
    return {
      kind: nudge.kind,
      kidName: nudge.kidName,
      what: nudge.title,
      where: nudge.venueName,
      when: nudge.whenLabel,
      day: nudge.saturday,
    };
  }
  if (nudge.kind === 'weekday_dropin') {
    // NO TIME OF DAY. The candidate row the decide read carries no clock time (the
    // reader does not select `summary`), so `day` is the only time-shaped fact there
    // is, and the skill's rule is to reuse the one it was given or say nothing.
    return {
      kind: nudge.kind,
      what: nudge.candidateRef.title,
      where: nudge.candidateRef.venueName,
      day: nudge.weekday,
      kidNames: nudge.kidNames,
    };
  }
  return {
    kind: nudge.kind,
    what: nudge.candidateRef.title,
    where: nudge.candidateRef.venueName,
    day: nudge.day,
    kidNames: nudge.kidNames,
    weatherFact: nudge.weatherFact,
    whyFacts: nudge.whyFacts,
  };
}

/** Every renderable fact, for the invented-fact lint. */
export function nudgeFactSlots(nudge: VoicedNudge): string[] {
  if (nudge.kind === 'registration') {
    const slots = [
      townLabel(nudge.windowRef.municipality),
      nudge.windowRef.cycleLabel,
      nudge.opensAtLocal,
      ...nudge.kidNames,
    ];
    if (nudge.residentNote) slots.push(nudge.residentNote);
    return slots;
  }
  if (nudge.kind === 'empty_saturday') {
    const slots = [nudge.title, nudge.kidName, nudge.saturday];
    if (nudge.venueName) slots.push(nudge.venueName);
    if (nudge.whenLabel) slots.push(nudge.whenLabel);
    return slots;
  }
  if (nudge.kind === 'weekday_dropin') {
    const slots = [nudge.candidateRef.title, nudge.weekday, ...nudge.kidNames];
    if (nudge.candidateRef.venueName) slots.push(nudge.candidateRef.venueName);
    return slots;
  }
  const slots = [
    nudge.candidateRef.title,
    nudge.day,
    nudge.weatherFact,
    ...nudge.kidNames,
    ...nudge.whyFacts,
  ];
  if (nudge.candidateRef.venueName) slots.push(nudge.candidateRef.venueName);
  return slots;
}

/** Every user-facing string in the voice, for the lint. */
export function nudgeVoiceStrings(voice: NudgeVoice): string[] {
  return [voice.message];
}

/** Parse the model's JSON answer into a typed voice, or null when unusable. */
export function parseNudgeVoiceAnswer(answer: string | null): NudgeVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = nudgeVoiceSchema.safeParse(value);
  if (!parsed.success || parsed.data.message.trim().length === 0) return null;
  return parsed.data;
}

/** Whether a composed message may be sent as-is: grounded, free of the opt-out line,
 * and inside the segment budget. The budget still reserves the old line so a message
 * that used to fit still fits; the line itself is not appended. */
export function usableNudgeMessage(message: string, nudge: VoicedNudge): boolean {
  if (findInventedFacts(message, nudgeFactSlots(nudge)).length > 0) return false;
  if (message.includes(NUDGE_OPT_OUT)) return false;
  return smsSegments(`${message}\n\n${NUDGE_OPT_OUT}`) <= MAX_NUDGE_SEGMENTS;
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function dayLabel(day: string): string {
  return sentenceCase(day);
}

/** Capitalize a phrase authored to sit mid-sentence, at the point it becomes the start
 * of one. `weatherFact` is written as a clause ("the weekend forecast is wet") because
 * the composer weaves it into its own sentence; the deterministic render leads with it. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The grounded render: every fact from the decision, no model involved. It is what
 * goes out whenever the composed voice is unusable or unavailable — so an outage, a
 * bad answer, or a fabricated venue costs a parent WARMTH, never accuracy.
 *
 * DELIBERATELY a grounded terminal substitute, not a deferral: unlike the intro and
 * follow-up composers, which send nothing when they cannot compose, a nudge is
 * time-sensitive (a registration window, a dated swap), so an on-time plain render
 * beats silence. This divergence from the followup-defers doctrine is intended.
 *
 * Plain ASCII on purpose: one typographic dash would flip the whole SMS to UCS-2 and
 * halve the character budget (see sms-segments.ts).
 */
export function renderNudgeDeterministically(nudge: Nudge): string {
  // M8's health-admin copy has no voiced form at all — the static render IS the
  // message, not a fallback for one.
  if (nudge.kind === 'health_checkpoint') return renderHealthNudge(nudge);

  // Weekday care and empty Saturday have no canned sentence. The writer speaks,
  // or the send does not happen.
  if (nudge.kind === 'weekday_care' || nudge.kind === 'empty_saturday') {
    throw new Error(`renderNudgeDeterministically: ${nudge.kind} has no template`);
  }

  if (nudge.kind === 'registration') {
    const who = nudge.kidNames.length > 0 ? ` for ${joinNames(nudge.kidNames)}` : '';
    const resident = nudge.residentNote ? ` - ${nudge.residentNote}` : '';
    // The hedge is the whole point of ageApproximate: the match rests on a ±6-month
    // tolerance around an age the parent gave in words, so asserting the band would be
    // asserting something Hale does not know.
    const hedge = nudge.ageApproximate ? ' Worth a look if they are still in that band.' : '';
    return `${townLabel(nudge.windowRef.municipality)} ${nudge.windowRef.cycleLabel} registration opens ${nudge.opensAtLocal}${who}${resident}.${hedge}`;
  }

  if (nudge.kind === 'weekday_dropin') {
    const venue = nudge.candidateRef.venueName ? ` at ${nudge.candidateRef.venueName}` : '';
    const kids = nudge.kidNames.length > 0 ? ` for ${joinNames(nudge.kidNames)}` : '';
    return `${dayLabel(nudge.weekday)} weekday drop-in: ${nudge.candidateRef.title}${venue}${kids}.`;
  }

  const where = nudge.candidateRef.venueName ? ` at ${nudge.candidateRef.venueName}` : '';
  const who = nudge.kidNames.length > 0 ? ` for ${joinNames(nudge.kidNames)}` : '';
  const why = nudge.whyFacts.length > 0 ? ` (${nudge.whyFacts.join(', ')})` : '';
  return `${sentenceCase(nudge.weatherFact)}, so ${dayLabel(nudge.day)}: ${nudge.candidateRef.title}${where}${who}${why}.`;
}

/**
 * The nudge message for one decision. The model composes; the checks decide whether
 * its words ship. A null client (no API key, or the voice kill switch) skips the call
 * entirely — the deterministic render is a first-class outcome, not an error path.
 */
function withActivityLink(message: string, url: string | null): string {
  if (url === null || message.includes(url)) return message;
  return `${message} ${url}`;
}

/**
 * The Saturday line is model-written and names the session. There is no canned
 * sentence behind it: a missing client or a voice that fails the grounding check
 * is silence, named by the caller.
 */
async function composeEmptySaturday(
  nudge: EmptySaturdayNudge,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<string | null> {
  if (!deps.client) return null;
  let skill: Awaited<ReturnType<typeof loadNudgeVoiceSkill>>;
  try {
    skill = await loadNudgeVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'nudge: skill load failed - saturday unvoiced');
    return null;
  }
  const { voice } = await composeVoice<NudgeVoice>({
    skill,
    context: nudgeVoiceContext(nudge),
    factSlots: nudgeFactSlots(nudge),
    parse: parseNudgeVoiceAnswer,
    voiceStrings: nudgeVoiceStrings,
    client: deps.client,
    database: deps.database,
    familyId: deps.familyId,
    agentName: 'nudge-voice',
    traceName: 'nudge-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });
  if (!voice || !usableNudgeMessage(voice.message, nudge)) return null;
  const linked = withActivityLink(voice.message, nudge.url);
  if (smsSegments(`${linked}\n\n${NUDGE_OPT_OUT}`) > MAX_NUDGE_SEGMENTS) return null;
  if (!linked.toLowerCase().includes(nudge.title.toLowerCase())) return null;
  return linked;
}

export async function composeNudgeMessage(
  nudge: Nudge,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<string | null> {
  if (nudge.kind === 'empty_saturday') return composeEmptySaturday(nudge, deps);
  if (nudge.kind === 'weekday_care') return null;
  const deterministic = renderNudgeDeterministically(nudge);
  // A health checkpoint never reaches the model (VIL-243 · M8): deterministic copy is
  // REVIEWABLE copy, and this is the one message class where a warmer sentence is not
  // worth the chance of a sentence nobody approved.
  if (nudge.kind === 'health_checkpoint' || !deps.client) {
    return deterministic;
  }

  // Inside the fallback boundary, like M3's: a proactive send that is otherwise ready
  // should still go out in Hale's plainest words rather than not go out at all.
  let skill: Awaited<ReturnType<typeof loadNudgeVoiceSkill>>;
  try {
    skill = await loadNudgeVoiceSkill();
  } catch (err) {
    console.error(
      { err, familyId: deps.familyId },
      'nudge: skill load failed - deterministic render',
    );
    return deterministic;
  }

  const { voice } = await composeVoice<NudgeVoice>({
    skill,
    context: nudgeVoiceContext(nudge),
    factSlots: nudgeFactSlots(nudge),
    parse: parseNudgeVoiceAnswer,
    voiceStrings: nudgeVoiceStrings,
    client: deps.client,
    database: deps.database,
    familyId: deps.familyId,
    agentName: 'nudge-voice',
    traceName: 'nudge-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });

  if (!voice || !usableNudgeMessage(voice.message, nudge)) {
    if (voice) {
      console.error(
        { familyId: deps.familyId },
        'nudge: composed message failed the grounding/budget check - deterministic render',
      );
    }
    return deterministic;
  }
  return voice.message;
}
