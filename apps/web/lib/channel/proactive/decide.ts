import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject } from '~/lib/loop/voice/compose';
import type { CadencePreference, FamilySnapshot } from './snapshot';

/**
 * VIL-226 · parse and run the per-family decider. The skill
 * (`proactive-decider.md`) is the guidance. This file checks the shape and
 * refuses to call the model when the queue is empty.
 */

export type DeciderAction = 'send_now' | 'hold' | 'drop';

export interface DeciderDecision {
  action: DeciderAction;
  holdUntil: string | null;
  itemIds: string[];
  reason: string;
  frequencyPreference: CadencePreference | null;
}

const ACTIONS = new Set<DeciderAction>(['send_now', 'hold', 'drop']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preferenceOf(value: unknown): CadencePreference | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;
  if (value.direction !== 'less' && value.direction !== 'more') return null;
  if (typeof value.note !== 'string') return null;
  return { direction: value.direction, note: value.note };
}

export function parseDeciderDecision(answer: string | null): DeciderDecision | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (typeof raw.action !== 'string' || !ACTIONS.has(raw.action as DeciderAction)) return null;
  if (!Array.isArray(raw.item_ids) || raw.item_ids.some((id) => typeof id !== 'string')) {
    return null;
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim().length === 0) return null;
  const holdUntil = raw.hold_until;
  if (holdUntil !== null && typeof holdUntil !== 'string') return null;
  const frequency = preferenceOf(raw.frequency_preference);
  if (raw.frequency_preference != null && frequency === null) return null;
  return {
    action: raw.action as DeciderAction,
    holdUntil: holdUntil ?? null,
    itemIds: raw.item_ids as string[],
    reason: raw.reason.trim(),
    frequencyPreference: frequency,
  };
}

export type DecideSkip = 'empty_queue' | 'no_client' | 'unparsed';

/**
 * Never calls the model when `candidates` is empty. A null client is a named
 * skip, not a send.
 */
export async function decideForFamily(input: {
  snapshot: FamilySnapshot;
  client: AgentClient | null;
  database: Database;
  familyId: string;
}): Promise<{ decision: DeciderDecision | null; skipped: DecideSkip | null }> {
  if (input.snapshot.candidates.length === 0) {
    return { decision: null, skipped: 'empty_queue' };
  }
  if (!input.client) return { decision: null, skipped: 'no_client' };
  const skill = await loadCronSkill('proactive-decider');
  const slots = [
    ...input.snapshot.candidates.flatMap((item) =>
      [item.what, item.why, item.sourceUrl, item.worthlessAfter].filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      ),
    ),
    ...input.snapshot.recentParentTexts,
    ...input.snapshot.freeWindows.flatMap((window) => [window.day, window.start, window.end]),
  ];
  const { voice } = await composeVoice<DeciderDecision>({
    skill,
    context: input.snapshot,
    factSlots: slots,
    parse: parseDeciderDecision,
    voiceStrings: () => [],
    client: input.client,
    database: input.database,
    familyId: input.familyId,
    agentName: 'proactive-decider',
    traceName: 'proactive-decider',
    maxTokens: 500,
  });
  if (!voice) return { decision: null, skipped: 'unparsed' };
  return { decision: voice, skipped: null };
}
