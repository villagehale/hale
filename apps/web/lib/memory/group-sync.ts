import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';

/**
 * The household-group line after a parent forgets or corrects a fact.
 * The value stays in the 1:1. The group hears only who, and which kind of change.
 */
export function renderMemoryGroupSync(
  language: ReplyLanguage | null,
  change: 'forget' | 'correct',
  who: string,
): Promise<string | null> {
  return speak({
    purpose: 'memory_group_sync',
    language,
    facts: { who, change },
    verbatim: [who],
  });
}
