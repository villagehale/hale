/**
 * VIL-447 (T23) shared lists. Off unless GROUP_SHARED_LISTS_ENABLED is exactly `true`
 * (`TRUE`, `1`, `on`, `true\n` stay off). Not set in any environment by this change.
 *
 * VIL-399 also arms the same path with GROUP_BRING_LIST_ENABLED (trimmed `true`).
 */
import { isEnabled } from '@hale/flags';

export const GROUP_SHARED_LISTS_ENABLED_ENV = 'GROUP_SHARED_LISTS_ENABLED';
export const GROUP_BRING_LIST_ENABLED_ENV = 'GROUP_BRING_LIST_ENABLED';

export function groupBringListEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[GROUP_BRING_LIST_ENABLED_ENV] ?? '').trim() === 'true';
}

export function groupSharedListsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('group-shared-lists', undefined, env) || groupBringListEnabled(env);
}
