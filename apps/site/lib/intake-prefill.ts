import type { Locale } from '~/i18n/routing';
import { INTAKE_PREFILL, INTAKE_PREFILL_FR } from '~/lib/text-entry';

/**
 * The composer body for this locale.
 *
 * English is {@link INTAKE_PREFILL}. French is {@link INTAKE_PREFILL_FR}
 * (Sloane 2026-09-30: ASCII apostrophe, no space before `?`). Chinese keeps
 * the English body; the page glosses it, because there is no locked Chinese
 * line for the parent to send.
 */
export function intakePrefill(locale: Locale): string {
  if (locale === 'fr') return INTAKE_PREFILL_FR;
  return INTAKE_PREFILL;
}
