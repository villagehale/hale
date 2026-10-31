import type { AgentClient, Skill } from '@hale/agent';
import type { Database } from '@hale/db';
import { type ReplyCopySurface, composeReplyCopy } from './compose';
import type { ReplyCopyLanguage } from './validate';

/**
 * The model-written layer over a duty or family-memory turn.
 *
 * No client, or a miss from the model: nothing is sent. The locked sentence
 * is the shape the validator compares against. It is not a reply.
 *
 * Not this layer: compliance replies, group sync, and the recall list lines.
 * Group sync stays the fixed sentence so a remembered value never rides into
 * the group. The recall list lines stay fixed; the model writes only the
 * opening and the closing around them.
 *
 * The ask budget is the locked line's. A line that is not already a question
 * may not grow one.
 */

export interface ReplyLayerDeps {
  client: AgentClient | null;
  database: Database;
  familyId: string;
  language: ReplyCopyLanguage;
  audience: 'direct' | 'group';
  surface: ReplyCopySurface;
  skill?: Skill;
}

export async function replyProse(
  deps: ReplyLayerDeps,
  input: {
    /** Legacy shape hint (memory surface). Never sent, never shown to the model. */
    fallback?: string;
    /** VIL-507: say outright whether the one next step may be a question. */
    questionAllowed?: boolean;
    /** VIL-507: what the line is for, read by the model; there is no sentence behind it. */
    purpose?: string;
    facts: readonly string[];
    sealedValues?: readonly string[];
  },
): Promise<string | null> {
  if (!deps.client) {
    console.info({ reason: 'not_configured', surface: deps.surface }, 'reply-copy: model unread');
    return null;
  }
  const result = await composeReplyCopy({
    client: deps.client,
    database: deps.database,
    familyId: deps.familyId,
    language: deps.language,
    audience: deps.audience,
    surface: deps.surface,
    shape: 'prose',
    facts: input.facts,
    sealedValues: input.sealedValues,
    questionAllowed: input.questionAllowed ?? (input.fallback ?? '').includes('?'),
    purpose: input.purpose,
    skill: deps.skill,
  });
  if (result.source !== 'model' || result.text.length === 0) return null;
  return result.text;
}

export async function replyFrame(
  deps: ReplyLayerDeps,
  input: {
    header: string;
    footer: string;
    facts: readonly string[];
    sealedValues?: readonly string[];
  },
): Promise<{ header: string; footer: string } | null> {
  if (!deps.client) {
    console.info({ reason: 'not_configured', surface: deps.surface }, 'reply-copy: model unread');
    return null;
  }
  const result = await composeReplyCopy({
    client: deps.client,
    database: deps.database,
    familyId: deps.familyId,
    language: deps.language,
    audience: deps.audience,
    surface: deps.surface,
    shape: 'frame',
    facts: input.facts,
    sealedValues: input.sealedValues,
    questionAllowed: input.footer.includes('?'),
    fallback: input.header,
    fallbackClosing: input.footer,
    skill: deps.skill,
  });
  if (result.source !== 'model' || !result.closing) return null;
  return { header: result.text, footer: result.closing };
}
