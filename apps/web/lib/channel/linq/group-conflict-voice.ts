import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { smallerLane } from '~/lib/channel/spoken-line';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  GROUP_CONFLICT_MAX_TOKENS,
  GROUP_CONFLICT_TOOL,
  type GroupConflictLineInput,
  groupConflictAlertUsable,
  groupConflictUserMessage,
} from './group-conflict';

/**
 * VIL-444 (T24) — the model writes the group's clash alert (skill `group-conflict-alert`).
 *
 * The skill's lane first, then a smaller model, then nothing: null means no alert goes
 * out on this pass. There is no fallback sentence, and no fallback poll option.
 */

export interface GroupConflictAlert {
  text: string;
  /** The who-takes poll's last option, written with the alert. Null: no poll goes with it. */
  figureItOut: string | null;
}

export interface GroupConflictWriter {
  write(input: GroupConflictLineInput): Promise<GroupConflictAlert | null>;
}

const outputSchema = z.object({ text: z.string(), figureItOut: z.string().nullish() });

export function createGroupConflictWriter(client: () => AgentClient): GroupConflictWriter {
  return {
    async write(input) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('group-conflict-alert');
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'group conflict alert: skill load failed',
        );
        console.error({ urgent: true }, 'URGENT: group conflict alert unwritten - page #ops now');
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
            userMessage: groupConflictUserMessage(input),
            toolName: GROUP_CONFLICT_TOOL.name,
            toolDescription: GROUP_CONFLICT_TOOL.description,
            inputJsonSchema: GROUP_CONFLICT_TOOL.inputSchema,
            schema: outputSchema,
            maxTokens: GROUP_CONFLICT_MAX_TOKENS,
          });
          const accepted = groupConflictAlertUsable(input, value);
          if (accepted) return accepted;
          console.warn(
            { attempt: attempt + 1, poll: input.poll !== null },
            'group conflict alert: unusable text',
          );
        } catch (err) {
          console.error(
            { attempt: attempt + 1, err: err instanceof Error ? err.name : 'unknown' },
            'group conflict alert: write failed',
          );
        }
      }
      console.error(
        { urgent: true },
        'URGENT: group conflict alert unwritten after a smaller model - page #ops now',
      );
      return null;
    },
  };
}

let shared: GroupConflictWriter | null = null;

export function sharedGroupConflictWriter(): GroupConflictWriter {
  shared ??= createGroupConflictWriter(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** Tests install a writer here; null restores the real one. */
export function setGroupConflictWriter(writer: GroupConflictWriter | null): void {
  shared = writer;
}
