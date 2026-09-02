/**
 * The Settings taxonomy (Instinct-adapted one-column refresh) and the deep-link
 * resolver that keeps every OLD link working. The page is a single centered column
 * of flat cards again, so the ids are real in-page ANCHORS rather than switcher
 * state: SettingsColumn resolves the URL hash — the seven pre-hub anchors and the
 * hub's six section ids included — to the section it should scroll to. `family` has
 * no section left on this page (the family editor moved to /family), and a hash
 * resolver cannot leave the page, so it falls to Account — whose card carries the
 * "Family & children" pointer row to /family.
 */

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'notif', label: 'Notifications' },
  { id: 'plan', label: 'Plan' },
  { id: 'apps', label: 'Connections' },
  { id: 'trust', label: 'Trust' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const DEFAULT_SECTION: SettingsSectionId = 'account';

/**
 * Every hash generation → the anchor that renders its content now. The pre-hub
 * seven anchors, the hub's section ids, and the current ids all resolve; privacy
 * and the data controls live in Trust. Unknown or empty → Account.
 */
const HASH_TO_SECTION: Record<string, SettingsSectionId> = {
  // pre-hub anchors, preserved
  profile: 'account',
  preferences: 'account',
  appearance: 'account',
  'connected-apps': 'apps',
  notifications: 'notif',
  billing: 'plan',
  privacy: 'trust',
  // the hub's section ids (family's section moved off this page → Account pointer)
  family: 'account',
  // current section ids (self)
  account: 'account',
  notif: 'notif',
  plan: 'plan',
  apps: 'apps',
  trust: 'trust',
  about: 'about',
};

/** Maps a URL hash (with or without the leading '#') to a settings anchor, so an
 * old deep link lands where its content moved. Unknown or empty → Account. */
export function resolveSection(hash: string | null | undefined): SettingsSectionId {
  if (!hash) return DEFAULT_SECTION;
  const key = hash.replace(/^#/, '').toLowerCase();
  return HASH_TO_SECTION[key] ?? DEFAULT_SECTION;
}
