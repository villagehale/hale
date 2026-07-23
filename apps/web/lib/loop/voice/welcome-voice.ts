import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadWelcomeVoiceSkill } from '~/lib/cron/skill';
import type { WelcomeContent, WelcomeVoice } from '~/lib/onboarding/welcome-email';
import { type ComposedVoice, composeVoice, firstJsonObject } from './compose';

/**
 * VIL-229 · item 3 — the welcome-email voice. Composed INLINE at the welcome trigger
 * over the COARSE intake ONLY: the greeting-ready first-name token and the pre-derived
 * coarse place + stage phrases — never a child name or DOB (rule #1). The model writes
 * a warm greeting, one village line, and a closing note; the deterministic shell
 * (structure, CTA, the three step links, CASL footer) stays fixed, and the renderer
 * falls back to the deterministic copy on any degrade (rule #8).
 */

const VOICE_MAX_TOKENS = 400;

/** The redacted view handed to the model — the coarse intake, nothing finer (rule #1). */
export function welcomeVoiceContext(content: WelcomeContent): {
  firstName: string;
  place: string | null;
  stage: string | null;
} {
  return { firstName: content.firstName, place: content.place, stage: content.stage };
}

/** The injected fact slots the lint grounds the voice against — the coarse phrases the
 * model was handed. The welcome voice carries no times/links (the shell renders links),
 * so any URL/time in the model's prose is an invention → degrade. */
export function welcomeVoiceFactSlots(content: WelcomeContent): string[] {
  return [content.firstName, content.place ?? '', content.stage ?? ''];
}

// Voice fields ONLY, strict — an unknown/extra key fails the parse → deterministic copy.
const welcomeVoiceSchema = z
  .object({
    greeting: z.string(),
    villageLine: z.string(),
    closingNote: z.string(),
  })
  .strict();

/** Parse the model's JSON answer into a typed WelcomeVoice, or null when unusable. */
export function parseWelcomeVoiceAnswer(answer: string | null): WelcomeVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = welcomeVoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every user-facing string in the voice, for the invented-fact lint. */
export function welcomeVoiceStrings(voice: WelcomeVoice): string[] {
  return [voice.greeting, voice.villageLine, voice.closingNote];
}

/**
 * Compose the welcome voice, or degrade to null. Fail-open (rule #8): a missing skill,
 * a broken answer, an invented fact, or a failed call all return null and the
 * deterministic welcome renders — the send is never blocked on the model.
 */
export async function composeWelcomeVoice(
  content: WelcomeContent,
  familyId: string,
  db: Database,
  client: AgentClient,
): Promise<ComposedVoice<WelcomeVoice>> {
  let skill: Awaited<ReturnType<typeof loadWelcomeVoiceSkill>>;
  try {
    skill = await loadWelcomeVoiceSkill();
  } catch (err) {
    console.error(
      { err, familyId, voice: 'welcome-voice' },
      'voice: welcome-voice skill load failed — deterministic welcome',
    );
    return { voice: null, degraded: true };
  }

  return composeVoice<WelcomeVoice>({
    skill,
    context: welcomeVoiceContext(content),
    factSlots: welcomeVoiceFactSlots(content),
    parse: parseWelcomeVoiceAnswer,
    voiceStrings: welcomeVoiceStrings,
    client,
    database: db,
    familyId,
    agentName: 'welcome-voice',
    traceName: 'welcome-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });
}
