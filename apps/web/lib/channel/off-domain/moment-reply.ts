import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type Moment,
  type MomentPlace,
  UNKNOWN_MOMENT_PLACE,
  momentJsonSchema,
  momentUserMessage,
} from './moment-request';

/**
 * The reply Hale sends when the ordinary answer must not go out.
 *
 * A skill writes it (moment-reply.md), in the parent's language, from the moment,
 * their words, and the coarse place when one is known. There is no preset sentence
 * underneath: could-not-answer, child health, a parent's crisis, and a physical
 * emergency are all this call. Crisis and emergency are reached only after the lane
 * has already stopped the search and the ordinary compose.
 *
 * When no sendable reply can be written, NOTHING is sent and the outcome says why
 * (rule #11). A thrown model call is retried inside the same budget as an empty
 * body. An empty body is the only thing the code refuses: a link or a phrase is
 * the judge's, not a pattern match.
 */

const MAX_ATTEMPTS = 2;
const MAX_TOKENS = 256;

export type { Moment } from './moment-request';

export type MomentUnwrittenReason =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unsendable';

export type MomentWrite =
  | { status: 'written'; reply: string }
  | { status: 'unwritten'; reason: MomentUnwrittenReason };

export interface MomentWriter {
  write(text: string, moment: Moment, place?: MomentPlace): Promise<MomentWrite>;
}

const replySchema = z.object({ reply: z.string() });

function unwritten(reason: MomentUnwrittenReason, detail?: string): MomentWrite {
  console.error({ reason, detail }, 'moment reply: no reply written');
  return { status: 'unwritten', reason };
}

/** An empty body cannot go out. The words are the model's, and the judge reads them. */
function unsended(body: string): boolean {
  return body === '';
}

/** The production writer, on the same lazy client as the lane's other model stages. */
export function createMomentReply(client: () => AgentClient): MomentWriter {
  return {
    async write(text, moment, place = UNKNOWN_MOMENT_PLACE) {
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

      let threw = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: momentUserMessage(moment, text, place),
            toolName: 'moment_reply',
            toolDescription: 'Return the one text for this moment.',
            inputJsonSchema: momentJsonSchema,
            schema: replySchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.reply;
          threw = false;
        } catch {
          threw = true;
          continue;
        }
        const reply = plainText(raw);
        if (!unsended(reply)) return { status: 'written', reply };
      }
      return unwritten(threw ? 'model_failed' : 'unsendable');
    },
  };
}
