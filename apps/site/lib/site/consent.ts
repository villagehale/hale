/**
 * Marketing-site cookie choice. Google Ads and PostHog stay unloaded until the
 * visitor taps Accept. The pre-paint script only reads the key; a write happens
 * on a button tap, never on load.
 */

export const CONSENT_STORAGE_KEY = 'hale-site-consent';

export const CONSENT_EVENT = 'hale:consent';

export const CONSENT_OPEN_EVENT = 'hale:consent-open';

export type ConsentChoice = 'granted' | 'denied';

export function isConsentChoice(value: unknown): value is ConsentChoice {
  return value === 'granted' || value === 'denied';
}

/** Blocked storage (Safari private mode) is undecided: load nothing. */
export function readConsent(): ConsentChoice | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return isConsentChoice(value) ? value : null;
  } catch {
    return null;
  }
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
 * data-consent so the banner stays hidden. No key, or storage that throws,
 * leaves the attribute off.
 */
export const CONSENT_NO_FLASH_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  CONSENT_STORAGE_KEY,
)});if(c==="granted"||c==="denied"){document.documentElement.setAttribute("data-consent",c);}else{document.documentElement.removeAttribute("data-consent");}}catch(e){}})();`;
