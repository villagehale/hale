import { type AgentClient, pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { z } from 'zod';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { carriesExactOptOutLine } from '~/lib/channel/opt-out';
import { loadCronSkill, loadNudgeVoiceSkill } from '~/lib/cron/skill';
import { composeVoice } from '~/lib/loop/voice/compose';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import type { EmptySaturdayNudge, Nudge, WeekdayCareAsk } from './nudge-decide';
import {
  type NudgeVoice,
  VOICE_MAX_TOKENS,
  type VoicedNudge,
  WEEKDAY_ASK_SKILL,
  nudgeFactSlots,
  nudgeVoiceContext,
  nudgeVoiceStrings,
  parseNudgeVoiceAnswer,
  withActivityLink,
} from './nudge-voice';
import {
  WEEKDAY_ASK_MAX_TOKENS,
  WEEKDAY_ASK_TOOL,
  WEEKDAY_ASK_TOOL_SCHEMA,
  readWeekdayAsk,
  weekdayAskContext,
} from './weekday-ask-tools';

/**
 * Dec 1 rule 1 for nudges, dark behind NUDGE_MODEL_ONLY_ENABLED: the model writes the
 * nudge or nothing goes out. With the flag off the sweep calls `composeNudgeMessage`
 * (nudge-voice.ts), whose fixed sentence and segment budget are what parents get today;
 * that path and this flag are removed together once this one is lit.
 */
export function nudgeModelOnlyEnabled(): boolean {
  return isEnabled('nudge-model-only');
}

/**
 * Why a nudge has no text: four problems with four different fixes. A missing key or the
 * voice kill switch, a deploy without its skill, a provider that did not answer, and an
 * answer that came back but could not be used. Named on the audit row and the #ops page.
 */
export type NudgeUnwrittenReason = 'no_client' | 'skill_load' | 'model_failed' | 'unusable';

/** The text for one decision, or why there is none. No fixed sentence stands behind it. */
export type NudgeWrite = { message: string } | { unwritten: NudgeUnwrittenReason };

type WriteDeps = { familyId: string; database: Database; client: AgentClient | null };

/** Grounded and free of the opt-out line. Its length is the model's to choose (Dec 1
 * rule 2); VOICE_MAX_TOKENS bounds a runaway. */
export function usableModelOnlyDraft(message: string, nudge: VoicedNudge): boolean {
  if (findInventedFacts(message, nudgeFactSlots(nudge)).length > 0) return false;
  return !carriesExactOptOutLine(message);
}

async function writeEmptySaturday(nudge: EmptySaturdayNudge, deps: WriteDeps): Promise<NudgeWrite> {
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
  if (!usableModelOnlyDraft(voice.message, nudge)) return { unwritten: 'unusable' };
  const linked = withActivityLink(voice.message, nudge.url);
  if (!linked.toLowerCase().includes(nudge.title.toLowerCase())) return { unwritten: 'unusable' };
  return { message: linked };
}

async function writeWeekdayCareAsk(nudge: WeekdayCareAsk, deps: WriteDeps): Promise<NudgeWrite> {
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
    // An answer that came back with nothing usable is a bad draft. Only a call that did
    // not come back at all is an outage.
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

/** The nudge's text, or why there is none. Nothing stands behind the model. */
export async function writeNudgeModelOnly(nudge: Nudge, deps: WriteDeps): Promise<NudgeWrite> {
  if (nudge.kind === 'empty_saturday') return writeEmptySaturday(nudge, deps);
  if (nudge.kind === 'weekday_care') return writeWeekdayCareAsk(nudge, deps);
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
  if (!usableModelOnlyDraft(voice.message, nudge)) {
    console.error(
      { familyId: deps.familyId },
      'nudge: composed message failed the grounding check - unvoiced',
    );
    return { unwritten: 'unusable' };
  }
  return { message: voice.message };
}
