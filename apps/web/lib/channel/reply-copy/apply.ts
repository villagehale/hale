import type { AgentClient, Skill } from '@hale/agent';
import type { Database } from '@hale/db';
import { type ReplyCopySurface, composeReplyCopy } from './compose';
import type { ReplyCopyLanguage } from './validate';

/**
 * The model-written layer over the locked duty and family-memory sentences.
 *
 * Flag off, or no injected client: the locked string goes out and the model
 * is not called. Flag on: the model writes from the facts, the validator runs,
 * and any miss sends the locked string.
 *
 * Not this layer: compliance replies, a refused memory edit, group sync, and
 * the recall list lines. Group sync stays the fixed sentence so a remembered
 * value never rides into the group. The recall list lines stay locked; the
 * model writes only the opening and the closing around them.
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
  /** `COPARENT_DUTY_COPY_LOCKED` or `FAMILY_MEMORY_KINDS_COPY_LOCKED`, already compared to `'true'`. */
  flagOn: boolean;
  surface: ReplyCopySurface;
  skill?: Skill;
}

export async function replyProse(
  deps: ReplyLayerDeps,
  input: { fallback: string; facts: readonly string[]; sealedValues?: readonly string[] },
): Promise<string> {
  if (!deps.flagOn || !deps.client) return input.fallback;
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
    questionAllowed: input.fallback.includes('?'),
    fallback: input.fallback,
    skill: deps.skill,
  });
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
): Promise<{ header: string; footer: string }> {
  if (!deps.flagOn || !deps.client) return { header: input.header, footer: input.footer };
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
  if (result.source !== 'model' || !result.closing) {
    return { header: input.header, footer: input.footer };
  }
  return { header: result.text, footer: result.closing };
}
