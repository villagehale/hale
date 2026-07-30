import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadNudgeVoiceSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import type { Nudge } from './nudge-decide';

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
 * this message is UNSOLICITED. So {@link NUDGE_OPT_OUT} is part of the shell, appended
 * by the sender exactly once, and a composed message that writes its own opt-out line
 * is rejected — a parent must never see the instruction twice, and must never see a
 * version of it the model paraphrased into something that isn't the keyword.
 */

const VOICE_MAX_TOKENS = 300;

/**
 * The CASL opt-out, appended to every proactive nudge. Not the model's to write and
 * not optional: an unsolicited commercial electronic message has to carry a working
 * unsubscribe, and 'STOP' is the keyword the intake machine actually honours
 * (lib/channel/intake/keywords.ts), so the copy names it verbatim.
 */
export const NUDGE_OPT_OUT = 'Reply STOP to opt out.';

/** The whole payload — this message plus the appended opt-out — must fit two SMS
 * segments. The deterministic render always fits, so the fallback is never itself
 * over budget. */
export const MAX_NUDGE_SEGMENTS = 2;

export interface NudgeVoice {
  message: string;
}

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
 * caller falls back to the deterministic render. */
const nudgeVoiceSchema = z.object({ message: z.string() }).strict();

/**
 * What the model is handed: the nudge's FACTS, and nothing else. No candidate uuid, no
 * internal municipality token. `kind` rides along because the two shapes want
 * different emphasis — a deadline is urgent, a weekend swap is an offer — and the
 * skill needs to know which one it is holding.
 */
export function nudgeVoiceContext(nudge: Nudge): unknown {
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
export function nudgeFactSlots(nudge: Nudge): string[] {
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

/** Whether a composed message may be sent as-is: grounded, free of the shell's own
 * opt-out line, and inside the segment budget once that line is appended. */
export function usableNudgeMessage(message: string, nudge: Nudge): boolean {
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
  return day.charAt(0).toUpperCase() + day.slice(1);
}

/**
 * The grounded render: every fact from the decision, no model involved. It is what
 * goes out whenever the composed voice is unusable or unavailable — so an outage, a
 * bad answer, or a fabricated venue costs a parent WARMTH, never accuracy.
 *
 * Plain ASCII on purpose: one typographic dash would flip the whole SMS to UCS-2 and
 * halve the character budget (see sms-segments.ts).
 */
export function renderNudgeDeterministically(nudge: Nudge): string {
  if (nudge.kind === 'registration') {
    const who = nudge.kidNames.length > 0 ? ` for ${joinNames(nudge.kidNames)}` : '';
    const resident = nudge.residentNote ? ` - ${nudge.residentNote}` : '';
    // The hedge is the whole point of ageApproximate: the match rests on a ±6-month
    // tolerance around an age the parent gave in words, so asserting the band would be
    // asserting something Hale does not know.
    const hedge = nudge.ageApproximate ? ' Worth a look if they are still in that band.' : '';
    return `${townLabel(nudge.windowRef.municipality)} ${nudge.windowRef.cycleLabel} registration opens ${nudge.opensAtLocal}${who}${resident}.${hedge}`;
  }

  const where = nudge.candidateRef.venueName ? ` at ${nudge.candidateRef.venueName}` : '';
  const who = nudge.kidNames.length > 0 ? ` for ${joinNames(nudge.kidNames)}` : '';
  const why = nudge.whyFacts.length > 0 ? ` (${nudge.whyFacts.join(', ')})` : '';
  return `${nudge.weatherFact}, so ${dayLabel(nudge.day)}: ${nudge.candidateRef.title}${where}${who}${why}.`;
}

/**
 * The nudge message for one decision. The model composes; the checks decide whether
 * its words ship. A null client (no API key, or the voice kill switch) skips the call
 * entirely — the deterministic render is a first-class outcome, not an error path.
 */
export async function composeNudgeMessage(
  nudge: Nudge,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<string> {
  const deterministic = renderNudgeDeterministically(nudge);
  if (!deps.client) return deterministic;

  // Inside the fallback boundary, like M3's: a proactive send that is otherwise ready
  // should still go out in Hale's plainest words rather than not go out at all.
  let skill: Awaited<ReturnType<typeof loadNudgeVoiceSkill>>;
  try {
    skill = await loadNudgeVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'nudge: skill load failed - deterministic render');
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
