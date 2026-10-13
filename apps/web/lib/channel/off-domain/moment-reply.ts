import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type Moment, momentJsonSchema, momentUserMessage } from './moment-request';

/**
 * The reply Hale sends when the ordinary answer must not go out.
 *
 * A skill writes it (moment-reply.md), in the parent's language, from the moment
 * and their words. There is no preset sentence underneath: could-not-answer,
 * child health, a parent's crisis, and a physical emergency are all this call.
 * Crisis and emergency are reached only after the lane has already stopped the
 * search and the ordinary compose.
 *
 * When no sendable reply can be written, NOTHING is sent and the outcome says why
 * (rule #11).
 */

const MAX_ATTEMPTS = 2;
const MAX_TOKENS = 256;

const LINK_SHAPE = /https?:\/\/|www\./i;
const APP_POINTER = /\b(the app|in-app|your dashboard|the website|villagehale)\b/i;

export type MomentUnwrittenReason =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unsendable';

export type MomentWrite =
  | { status: 'written'; reply: string }
  | { status: 'unwritten'; reason: MomentUnwrittenReason };

export interface MomentWriter {
  write(text: string, moment: Moment): Promise<MomentWrite>;
}

const replySchema = z.object({ reply: z.string() });

function unwritten(reason: MomentUnwrittenReason, detail?: string): MomentWrite {
  console.error({ reason, detail }, 'moment reply: no reply written');
  return { status: 'unwritten', reason };
}

/** Empty, a link, or a pointer at the app cannot go out. The words are the model's. */
function unsended(body: string): boolean {
  return body === '' || LINK_SHAPE.test(body) || APP_POINTER.test(body);
}

/** The production writer, on the same lazy client as the lane's other model stages. */
export function createMomentReply(client: () => AgentClient): MomentWriter {
  return {
    async write(text, moment) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        return unwritten('client_unavailable');
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('moment-reply');
      } catch {
        return unwritten('skill_unavailable');
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: momentUserMessage(moment, text),
            toolName: 'moment_reply',
            toolDescription: 'Return the one text for this moment.',
            inputJsonSchema: momentJsonSchema,
            schema: replySchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.reply;
        } catch {
          return unwritten('model_failed');
        }
        const reply = plainText(raw);
        if (!unsended(reply)) return { status: 'written', reply };
      }
      return unwritten('unsendable');
    },
  };
}
