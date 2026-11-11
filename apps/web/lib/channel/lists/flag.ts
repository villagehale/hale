/**
 * VIL-447 (T23) shared lists. Off unless GROUP_SHARED_LISTS_ENABLED is exactly `true`
 * (`TRUE`, `1`, `on`, `true\n` stay off). Not set in any environment by this change.
 */
import { isEnabled } from '@hale/flags';

export const GROUP_SHARED_LISTS_ENABLED_ENV = 'GROUP_SHARED_LISTS_ENABLED';

export function groupSharedListsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('group-shared-lists', undefined, env);
}
