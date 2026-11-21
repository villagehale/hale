import type { AgentClient } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';
import { type BringItemsReader, createBringItemsReader } from './read';

/**
 * VIL-720 · the production reader: the skill off disk (rule #2, by name) and the caller's
 * client. No key is `unavailable: no_key`, the event-notes reader's rule.
 */
export function productionBringItemsReader(client: () => AgentClient): BringItemsReader {
  return createBringItemsReader({
    client,
    loadSkill: loadCronSkill,
    hasKey: () => Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
