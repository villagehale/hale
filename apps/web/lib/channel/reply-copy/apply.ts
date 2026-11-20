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
 * Not this layer: compliance replies and group sync. A family-memory list is
 * written whole by the model from the facts (VIL-723): there are no code-built
 * list lines for it to frame.
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
  /** A skill other than `reply-copy`, loaded by name inside the composer (rule #2). */
  skillName?: string;
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
    /** Output budget for a long reply (a family-memory list). Absent: the short default. */
    maxTokens?: number;
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
    skillName: deps.skillName,
    maxTokens: input.maxTokens,
  });
  if (result.source !== 'model' || result.text.length === 0) return null;
  return result.text;
}
