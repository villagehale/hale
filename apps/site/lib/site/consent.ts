/**
 * Marketing-site measurement choice.
 *
 * A stored Accept or Turn off / No thanks wins. With nothing stored, an
 * opt-out region (see consent-region.ts) loads the tags, and an opt-in
 * region does not. Global Privacy Control (`data-gpc`) blocks that default.
 * Callers that fire a browser event, including Purchase, read this function
 * so they follow the same decision as the banner.
 *
 * The pre-paint script only reads storage and the browser GPC flag. It does
 * not write a choice. A default-on visit loads tags without storing Accept.
 * Storage that throws loads nothing: a refusal could not be saved.
 */

export const CONSENT_STORAGE_KEY = 'hale-site-consent';

export const CONSENT_EVENT = 'hale:consent';

export const CONSENT_OPEN_EVENT = 'hale:consent-open';

export type ConsentChoice = 'granted' | 'denied';

export function isConsentChoice(value: unknown): value is ConsentChoice {
  return value === 'granted' || value === 'denied';
}

/**
 * Blocked storage (Safari private mode) is undecided: load nothing. A missing
 * key is not the same thing, and the region default can still apply.
 */
export function readStoredConsent(): { choice: ConsentChoice | null; blocked: boolean } {
  if (typeof window === 'undefined') return { choice: null, blocked: false };
  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return { choice: isConsentChoice(value) ? value : null, blocked: false };
  } catch {
    return { choice: null, blocked: true };
  }
}

export function browserGlobalPrivacyControl(): boolean {
  if (typeof navigator === 'undefined') return false;
  const flag = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
  return flag === true;
}

/**
 * Effective choice for loading tags and firing browser events.
 * `granted` means measurement is on (a stored Accept, or a default-on region
 * with no refusal and no Global Privacy Control). `denied` is a stored
 * refusal. `null` means nothing loads.
 */
export function readConsent(): ConsentChoice | null {
  const stored = readStoredConsent();
  if (stored.blocked) return null;
  if (stored.choice) return stored.choice;
  if (typeof document === 'undefined') return null;
  const root = document.documentElement;
  if (root.dataset.gpc === '1') return null;
  if (root.dataset.consentMode === 'opt-out') return 'granted';
  return null;
}

/** Returns false when storage is blocked, and writes nothing in that case. */
export function writeConsent(choice: ConsentChoice): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    return false;
  }
  document.documentElement.setAttribute('data-consent', choice);
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }));
  return true;
}

/**
 * Runs before first paint, next to the theme script. A stored choice sets
 * data-consent so the banner stays hidden. A browser Global Privacy Control
 * signal sets data-gpc so the default-on path does not load. No key, or
 * storage that throws, leaves data-consent off.
 */
export const CONSENT_NO_FLASH_SCRIPT = `(function(){try{if(navigator.globalPrivacyControl){document.documentElement.setAttribute("data-gpc","1");}}catch(e){}try{var c=localStorage.getItem(${JSON.stringify(
  CONSENT_STORAGE_KEY,
)});if(c==="granted"||c==="denied"){document.documentElement.setAttribute("data-consent",c);}else{document.documentElement.removeAttribute("data-consent");}}catch(e){}})();`;
