import type { AgentClient } from '@hale/agent';
import type { Database } from '@hale/db';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice } from '~/lib/loop/voice/compose';
import type { SnapshotCandidate } from './snapshot';

/**
 * VIL-226 · one writer for a batch the decider already chose. No template
 * behind it: a missing client or a voice that drops a link is silence.
 * Links the model omitted are appended here, after the grounding check.
 */

export interface ComposedBatch {
  message: string;
}

function parseBatch(answer: string | null): ComposedBatch | null {
  if (!answer) return null;
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(answer.slice(start, end + 1)) as { message?: unknown };
    if (typeof raw.message !== 'string' || raw.message.trim().length === 0) return null;
    return { message: raw.message.trim() };
  } catch {
    return null;
  }
}

/** Append each activity URL the reply named but did not link. */
export function withActivityLinks(message: string, items: readonly SnapshotCandidate[]): string {
  let next = message;
  for (const item of items) {
    if (!item.sourceUrl || next.includes(item.sourceUrl)) continue;
    const words = item.what
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    if (words.length === 0) continue;
    const body = next.toLowerCase();
    if (!words.every((word) => body.includes(word))) continue;
    next = `${next} ${item.sourceUrl}`;
  }
  return next;
}

export async function composeProactiveBatch(input: {
  items: readonly SnapshotCandidate[];
  client: AgentClient | null;
  database: Database;
  familyId: string;
}): Promise<string | null> {
  if (input.items.length === 0 || !input.client) return null;
  const skill = await loadCronSkill('proactive-writer');
  const slots = input.items.flatMap((item) =>
    [item.what, item.why, item.sourceUrl].filter((part): part is string => Boolean(part)),
  );
  const { voice } = await composeVoice<ComposedBatch>({
    skill,
    context: { items: input.items },
    factSlots: slots,
    parse: parseBatch,
    voiceStrings: (batch) => [batch.message],
    client: input.client,
    database: input.database,
    familyId: input.familyId,
    agentName: 'proactive-writer',
    traceName: 'proactive-writer',
    maxTokens: 400,
  });
  if (!voice) return null;
  return withActivityLinks(voice.message, input.items);
}
