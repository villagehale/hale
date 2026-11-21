import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-717 · WHICH SLOW JOB A TEXT ASKS FOR — the only step that reads the parent's words.
 *
 * It returns a category from a closed list and nothing else, so the line the parent reads is
 * written by another step that never sees what they wrote (compose.ts): it cannot repeat a
 * child's name back, cannot pretend to know the answer, and cannot be steered by words in
 * the text. Meaning is the model's (no keyword list); the skill is `ack-eta-read`.
 *
 * Every way it cannot answer is named (rule #11). A category off the list is a read that
 * did not happen, never a guess.
 */

/** The three kinds of slow work an ack covers. Mirrors `ACK_PROMISE_TASKS` (@hale/db). */
export const ACK_TASKS = ['registration', 'research', 'find'] as const;
export type AckTask = (typeof ACK_TASKS)[number];

export type AckTaskUnread = 'client_unavailable' | 'skill_unavailable' | 'model_failed';

export type AckTaskReading =
  | { status: 'read'; task: AckTask | 'none' }
  | { status: 'unread'; reason: AckTaskUnread };

export interface AckTaskReader {
  read(parentText: string): Promise<AckTaskReading>;
}

export const ACK_TASK_READ_TOOL = 'ack_task_read';
export const ACK_TASK_READ_DESCRIPTION =
  'Return which kind of slow work this text asks Hale to do, or none.';
/** A runaway ceiling for one word, with room for the lane's thinking. */
export const ACK_TASK_READ_MAX_TOKENS = 256;

export const ACK_TASK_READ_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', enum: ['registration', 'research', 'find', 'none'] },
  },
  required: ['task'],
} as const;

const readingSchema = z.object({ task: z.string() });

/** The read's user turn. Shared with the eval, which replays this request. */
export function ackTaskReadUserMessage(parentText: string): string {
  return JSON.stringify({ parent_text: parentText });
}

/** The request the read sends. Loading it calls no model; the eval prices and replays it. */
export async function ackTaskReadRequest(parentText: string) {
  const skill = await loadCronSkill('ack-eta-read');
  return {
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: ackTaskReadUserMessage(parentText),
    toolName: ACK_TASK_READ_TOOL,
    toolDescription: ACK_TASK_READ_DESCRIPTION,
    toolSchema: ACK_TASK_READ_SCHEMA,
    maxTokens: ACK_TASK_READ_MAX_TOKENS,
  };
}

/** The model's word, as a category, or null when it named none on the list. */
export function toAckTask(raw: string): AckTask | 'none' | null {
  const value = raw.trim();
  if (value === 'none') return 'none';
  return (ACK_TASKS as readonly string[]).includes(value) ? (value as AckTask) : null;
}

function unread(reason: AckTaskUnread): AckTaskReading {
  // The reason only: a provider error can carry the request, and the request is the
  // parent's text (rule #1).
  console.error({ reason }, 'ack eta: the slow-job read did not answer');
  return { status: 'unread', reason };
}

/** The production read, on a lazily resolved client like the holding line's. */
export function createAckTaskReader(client: () => AgentClient): AckTaskReader {
  return {
    async read(parentText) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        return unread('client_unavailable');
      }
      let request: Awaited<ReturnType<typeof ackTaskReadRequest>>;
      try {
        request = await ackTaskReadRequest(parentText);
      } catch {
        return unread('skill_unavailable');
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: request.lane,
          system: request.system,
          userMessage: request.userMessage,
          toolName: request.toolName,
          toolDescription: request.toolDescription,
          inputJsonSchema: request.toolSchema,
          schema: readingSchema,
          maxTokens: request.maxTokens,
        });
        const task = toAckTask(value.task);
        if (task === null) return unread('model_failed');
        return { status: 'read', task };
      } catch {
        return unread('model_failed');
      }
    },
  };
}
