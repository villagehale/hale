import { type AgentClient } from '@hale/agent';
import { type Database, type WeekPlanItem, type WeekPlanVoice } from '@hale/db';
import { z } from 'zod';
import { loadWeekSummarySkill } from '~/lib/cron/skill';
import { timeLabel } from '~/lib/loop/templates/weekly-plan/core';
import { type ComposedVoice, composeVoice, firstJsonObject } from './compose';

/**
 * VIL-229 · item 1 — the weekly-plan voice. The weekly-plan composer's single agent
 * stage (was `summarizeWeek`, one free-text sentence) now composes the full voice
 * object over the SAME already-composed, already-redacted items the renderer sees: a
 * warm greeting, a one/two-sentence week framing, optional per-item framing keyed by
 * item index, and a sign-off. Facts (titles, dates, times, links) are INJECTED by the
 * renderer — the model writes AROUND them and the lint rejects any invented time/link
 * (composeVoice then degrades to the deterministic plan; rule #8).
 *
 * Rule #1: the items are already teen-redacted at compose time (a teen carries a
 * generic title, no name) — the model is never handed a teen name.
 */

const VOICE_MAX_TOKENS = 512;

/** The redacted view handed to the model: each item keyed by its index (the id the
 * model returns `itemLines` under), plus the facts it may reuse but never invent. This
 * is the SAME data the renderer reads off `payload.items` — no more (rule #1). */
export function weekVoiceContext(items: WeekPlanItem[]): {
  items: Array<{ id: string; kind: string; title: string; when: string | null }>;
} {
  return {
    items: items.map((item, i) => ({
      id: String(i),
      kind: item.kind,
      title: item.title,
      when: item.startsAt,
    })),
  };
}

/** The injected fact slots the lint grounds the voice against: every item's title,
 * its raw date key, and its human time label (when timed). A voice string carrying a
 * time or link absent from all of these is a fabrication → degrade. */
export function weekVoiceFactSlots(items: WeekPlanItem[]): string[] {
  const slots: string[] = [];
  for (const item of items) {
    slots.push(item.title);
    if (item.startsAt) slots.push(item.startsAt);
    const time = timeLabel(item.startsAt);
    if (time) slots.push(time);
  }
  return slots;
}

// Voice fields ONLY, strict: an unknown/extra top-level key fails the parse and the
// caller falls back to the deterministic plan. `itemLines` is lenient on keys (the
// renderer only reads ids it has), strict on value type.
const weekVoiceSchema = z
  .object({
    greeting: z.string(),
    weekFraming: z.string(),
    itemLines: z.record(z.string()).default({}),
    signOff: z.string(),
  })
  .strict();

/** Parse the model's JSON answer into a typed WeekPlanVoice, or null when it carries
 * no usable object / has extra fields (the caller then renders deterministically). */
export function parseWeekVoiceAnswer(answer: string | null): WeekPlanVoice | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = weekVoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Every user-facing string in the voice, for the invented-fact lint. */
export function weekVoiceStrings(voice: WeekPlanVoice): string[] {
  return [voice.greeting, voice.weekFraming, voice.signOff, ...Object.values(voice.itemLines)];
}

/**
 * Compose the weekly-plan voice, or degrade to null. Fail-open by construction
 * (rule #8): a quiet (empty) week skips voice entirely (deterministic quiet line);
 * a missing skill file, a broken answer, an invented fact, or a failed model call all
 * return `{ voice: null }` and log — the plan persists + sends either way, never
 * blocked on model availability. The skill body IS the prompt (rule #2).
 */
export async function composeWeekVoice(
  items: WeekPlanItem[],
  familyId: string,
  db: Database,
  client: AgentClient,
): Promise<ComposedVoice<WeekPlanVoice>> {
  // No items → nothing to voice; the deterministic quiet line renders. Not a failure.
  if (items.length === 0) return { voice: null, degraded: false };

  let skill: Awaited<ReturnType<typeof loadWeekSummarySkill>>;
  try {
    skill = await loadWeekSummarySkill();
  } catch (err) {
    // Send-safety (binding architecture): the voice stage NEVER throws — a missing/
    // broken skill degrades to the deterministic plan rather than failing the compose.
    console.error({ err, familyId, voice: 'weekly-plan-voice' }, 'voice: week-summary skill load failed — deterministic plan');
    return { voice: null, degraded: true };
  }

  return composeVoice<WeekPlanVoice>({
    skill,
    context: weekVoiceContext(items),
    factSlots: weekVoiceFactSlots(items),
    parse: parseWeekVoiceAnswer,
    voiceStrings: weekVoiceStrings,
    client,
    database: db,
    familyId,
    agentName: 'weekly-plan-voice',
    traceName: 'weekly-plan-voice',
    maxTokens: VOICE_MAX_TOKENS,
  });
}
