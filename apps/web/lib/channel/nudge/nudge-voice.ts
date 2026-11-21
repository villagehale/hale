import { type AgentClient, pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill, loadNudgeVoiceSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import type { EmptySaturdayNudge, Nudge, WeekdayCareAsk } from './nudge-decide';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from './shell';
import {
  WEEKDAY_ASK_MAX_TOKENS,
  WEEKDAY_ASK_TOOL,
  WEEKDAY_ASK_TOOL_SCHEMA,
  readWeekdayAsk,
  weekdayAskContext,
} from './weekday-ask-tools';

/**
 * VIL-239 · M4 — COMPOSE: the decision object, said out loud in Hale's voice.
 *
 * ONE model call, and it writes only WORDS. Every fact — the town, the open time, the
 * venue, the day, the kids' names, the weather claim — is injected by DECIDE, and the
 * composed message is checked back against those facts before it is allowed near a
 * parent. The model cannot invent a venue Hale never found, because a message carrying
 * one is discarded and nothing goes out in its place.
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
export type VoicedNudge = Exclude<Nudge, WeekdayCareAsk>;

/** Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and
 * nothing is sent. */
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

/**
 * Why a nudge has no text: four problems with four different fixes. A missing key or the
 * voice kill switch, a deploy without its skill, a provider that did not answer, and an
 * answer that came back but could not be used. Only the last says anything about this
 * nudge, so it is the only one the sweep counts against it (run.ts).
 */
export type NudgeUnwrittenReason = 'no_client' | 'skill_load' | 'model_failed' | 'unusable';

/** The text for one decision, or why there is none. No fixed sentence stands behind it. */
export type NudgeWrite = { message: string } | { unwritten: NudgeUnwrittenReason };

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
): Promise<NudgeWrite> {
  if (!deps.client) return { unwritten: 'no_client' };
  let skill: Awaited<ReturnType<typeof loadNudgeVoiceSkill>>;
  try {
    skill = await loadNudgeVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'nudge: skill load failed - saturday unvoiced');
    return { unwritten: 'skill_load' };
  }
  const { voice, reason } = await composeVoice<NudgeVoice>({
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
  if (!voice) return { unwritten: reason === 'unavailable' ? 'model_failed' : 'unusable' };
  if (!usableNudgeMessage(voice.message, nudge)) return { unwritten: 'unusable' };
  const linked = withActivityLink(voice.message, nudge.url);
  if (smsSegments(`${linked}\n\n${NUDGE_OPT_OUT}`) > MAX_NUDGE_SEGMENTS) {
    return { unwritten: 'unusable' };
  }
  if (!linked.toLowerCase().includes(nudge.title.toLowerCase())) return { unwritten: 'unusable' };
  return { message: linked };
}

export const WEEKDAY_ASK_SKILL = 'weekday-care-ask';

/**
 * The weekday-care offer, written by the model in the family's language and checked
 * against the offer that was chosen (weekday-ask-tools.ts). No canned sentence: a missing
 * client, a failed call or a text that fails the check is silence, named `unvoiced` by
 * the caller.
 */
async function composeWeekdayCareAsk(
  nudge: WeekdayCareAsk,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<NudgeWrite> {
  if (!deps.client) return { unwritten: 'no_client' };
  const language = await familySpeechLanguage(deps.database, deps.familyId);
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(WEEKDAY_ASK_SKILL);
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'nudge: skill load failed - ask unvoiced');
    return { unwritten: 'skill_load' };
  }
  let value: unknown;
  try {
    const result = await forceToolJson({
      client: deps.client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: weekdayAskContext(nudge.ask, language),
      toolName: WEEKDAY_ASK_TOOL,
      toolDescription: 'The one text Hale sends.',
      inputJsonSchema: WEEKDAY_ASK_TOOL_SCHEMA,
      schema: z.unknown(),
      maxTokens: WEEKDAY_ASK_MAX_TOKENS,
    });
    value = result.value;
  } catch (err) {
    // Never the message: a provider 400 can quote the request, parent words and all.
    console.error(
      { err: err instanceof Error ? err.constructor.name : 'unknown', familyId: deps.familyId },
      'nudge: weekday ask model call failed - unvoiced',
    );
    // An answer that came back with nothing usable is a bad draft and spends one of this
    // ask's tries. Only a call that did not come back at all is an outage.
    return { unwritten: err instanceof StructuredOutputError ? 'unusable' : 'model_failed' };
  }
  const read = readWeekdayAsk(value, nudge.ask);
  if ('skipped' in read) {
    console.error(
      { familyId: deps.familyId, reason: read.skipped, prompt: nudge.ask.prompt },
      'nudge: weekday ask refused - unvoiced',
    );
    return { unwritten: 'unusable' };
  }
  return { message: read.message };
}

/**
 * The nudge message for one decision. The model composes; the checks decide whether its
 * words ship. When it cannot be written there is nothing to send, and the caller is told
 * why (Dec 1 rule 1).
 */
export async function composeNudgeMessage(
  nudge: Nudge,
  deps: { familyId: string; database: Database; client: AgentClient | null },
): Promise<NudgeWrite> {
  if (nudge.kind === 'empty_saturday') return composeEmptySaturday(nudge, deps);
  if (nudge.kind === 'weekday_care') return composeWeekdayCareAsk(nudge, deps);
  if (!deps.client) return { unwritten: 'no_client' };

  let skill: Awaited<ReturnType<typeof loadNudgeVoiceSkill>>;
  try {
    skill = await loadNudgeVoiceSkill();
  } catch (err) {
    console.error({ err, familyId: deps.familyId }, 'nudge: skill load failed - unvoiced');
    return { unwritten: 'skill_load' };
  }

  const { voice, reason } = await composeVoice<NudgeVoice>({
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

  if (!voice) return { unwritten: reason === 'unavailable' ? 'model_failed' : 'unusable' };
  if (!usableNudgeMessage(voice.message, nudge)) {
    console.error(
      { familyId: deps.familyId },
      'nudge: composed message failed the grounding/budget check - unvoiced',
    );
    return { unwritten: 'unusable' };
  }
  return { message: voice.message };
}
