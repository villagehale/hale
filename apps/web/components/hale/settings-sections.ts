/**
 * The Settings hub's six-section taxonomy (desktop design handoff §4.7) and the
 * deep-link resolver that keeps the OLD seven-anchor links working. The prior
 * Account page used hash anchors (#profile, #billing, …); the hub is now a
 * section switcher, so those old links — and the still-live /settings#billing
 * link from the Family hub — must resolve to the right section rather than
 * dead-ending. New section ids map to themselves; unknown/empty falls to Account.
 */

export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'family', label: 'Family & children' },
  { id: 'plan', label: 'Plan & billing' },
  { id: 'notif', label: 'Notifications' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'about', label: 'Support & about' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export const DEFAULT_SECTION: SettingsSectionId = 'account';

/**
 * Old seven-anchor ids (and the new section ids) → the section that renders them.
 * Preferences + Appearance folded into Account; Privacy & data folded into Support
 * & about; the rest map one-to-one.
 */
const HASH_TO_SECTION: Record<string, SettingsSectionId> = {
  // old anchors, preserved
  profile: 'account',
  preferences: 'account',
  appearance: 'account',
  'connected-apps': 'apps',
  notifications: 'notif',
  billing: 'plan',
  privacy: 'about',
  // new section ids (self)
  account: 'account',
  family: 'family',
  plan: 'plan',
  notif: 'notif',
  apps: 'apps',
  about: 'about',
};

/** Maps a URL hash (with or without the leading '#') to a settings section, so an
 * old deep link lands where its content moved. Unknown or empty → Account. */
export function resolveSection(hash: string | null | undefined): SettingsSectionId {
  if (!hash) return DEFAULT_SECTION;
  const key = hash.replace(/^#/, '').toLowerCase();
  return HASH_TO_SECTION[key] ?? DEFAULT_SECTION;
}
