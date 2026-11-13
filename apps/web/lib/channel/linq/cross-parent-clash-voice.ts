import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { smallerLane } from '~/lib/channel/spoken-line';
import { loadCronSkill } from '~/lib/cron/skill';
import { db } from '~/lib/db';
import { type OpsPager, failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  CROSS_PARENT_CLASH_MAX_TOKENS,
  CROSS_PARENT_CLASH_TOOL,
  type CrossParentClashLineInput,
  crossParentClashTextUsable,
  crossParentClashUserMessage,
} from './cross-parent-clash';

/**
 * VIL-609 — the model writes one parent's private clash line (skill `cross-parent-clash`).
 *
 * The skill's lane first, then a smaller model, then nothing: null means no text goes
 * out to that parent on this pass, and #ops is paged. There is no fallback sentence.
 */

export interface CrossParentClashWriter {
  write(input: CrossParentClashLineInput): Promise<string | null>;
}

const outputSchema = z.object({ text: z.string() });

export function createCrossParentClashWriter(
  client: () => AgentClient,
  pager: OpsPager,
): CrossParentClashWriter {
  return {
    async write(input) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('cross-parent-clash');
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'cross-parent clash: skill load failed',
        );
        await pager.page({ site: 'group_conflict_unwritten', facts: { stage: 'skill_load' } });
        return null;
      }
      const first = pickLane(skill.meta.task);
      const lanes = [first, smallerLane(first)];
      for (let attempt = 0; attempt < lanes.length; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: client(),
            lane: lanes[attempt] ?? first,
            system: skill.instructions,
            userMessage: crossParentClashUserMessage(input),
            toolName: CROSS_PARENT_CLASH_TOOL.name,
            toolDescription: CROSS_PARENT_CLASH_TOOL.description,
            inputJsonSchema: CROSS_PARENT_CLASH_TOOL.inputSchema,
            schema: outputSchema,
            maxTokens: CROSS_PARENT_CLASH_MAX_TOKENS,
          });
          const accepted = crossParentClashTextUsable(value.text);
          if (accepted) return accepted;
          console.warn({ attempt: attempt + 1 }, 'cross-parent clash: unusable text');
        } catch (err) {
          console.error(
            { attempt: attempt + 1, err: err instanceof Error ? err.name : 'unknown' },
            'cross-parent clash: write failed',
          );
        }
      }
      await pager.page({ site: 'group_conflict_unwritten', facts: { stage: 'after_retry' } });
      return null;
    },
  };
}

let shared: CrossParentClashWriter | null = null;

export function sharedCrossParentClashWriter(): CrossParentClashWriter {
  shared ??= createCrossParentClashWriter(
    () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
    failurePageOpsPager(db),
  );
  return shared;
}

/** Tests install a writer here; null restores the real one. */
export function setCrossParentClashWriter(writer: CrossParentClashWriter | null): void {
  shared = writer;
}
