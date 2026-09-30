import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { INTAKE_PREFILL } from '~/lib/text-entry';

/**
 * The composer body for this locale.
 *
 * English is the locked hello {@link INTAKE_PREFILL}. French is the existing
 * `Text.sentGloss` — Sloane's twin, already on the /text page, not a new
 * string. Chinese keeps the English body; the page glosses it, because there
 * is no locked Chinese line for the parent to send.
 */
export function intakePrefill(locale: Locale): string {
  if (locale !== 'fr') return INTAKE_PREFILL;
  return getTranslator(locale, 'Text')('sentGloss');
}
