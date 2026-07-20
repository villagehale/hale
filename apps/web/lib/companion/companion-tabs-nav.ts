/**
 * The Companion sub-tab taxonomy (design handoff §4.3), reconciled to the real web
 * seams. Six tabs, in display order. The tab key rides the URL (`?tab=`) so a deep
 * link (or a refresh) lands on the same sub-tab. Kept pure + separate from the
 * component so the taxonomy and the URL parse are unit-testable and the server page
 * can seed the initial tab without importing the client bundle.
 */
export const COMPANION_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'health', label: 'Health' },
  { key: 'growth', label: 'Growth' },
  { key: 'milestones', label: 'Milestones' },
  { key: 'routines', label: 'Routines' },
  { key: 'documents', label: 'Documents' },
] as const;

export type CompanionTabKey = (typeof COMPANION_TABS)[number]['key'];

export const DEFAULT_COMPANION_TAB: CompanionTabKey = 'overview';

const TAB_KEYS = new Set<string>(COMPANION_TABS.map((t) => t.key));

/**
 * Resolve the `?tab=` param to a valid tab key, falling back to Overview for a
 * missing or unrecognized value (a hand-edited or stale link never lands on a blank
 * surface). A repeated param (`?tab=a&tab=b`) arrives as an array — take the first.
 */
export function tabFromParam(param: string | string[] | undefined): CompanionTabKey {
  const raw = Array.isArray(param) ? param[0] : param;
  return raw !== undefined && TAB_KEYS.has(raw) ? (raw as CompanionTabKey) : DEFAULT_COMPANION_TAB;
}
