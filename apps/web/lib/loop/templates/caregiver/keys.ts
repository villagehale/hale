/**
 * The two template keys a caregiver leg rides, and the predicate that recognises them.
 *
 * Their own module, with no imports, because three places have to agree on them and two
 * of those must not pull a renderer in to ask: the A2 dispatch (which picks the audit
 * verb for a third-party disclosure) and the senders. The registry holds the third.
 *
 * The `weekly_plan:` / `reminder:` prefixes are deliberate — the ledger's templateKey
 * column is how a caregiver disclosure is found later, and a key that shares its parent
 * leg's stem keeps the two side by side in that read instead of in two unrelated places.
 */

export const CAREGIVER_WEEKLY_PLAN_TEMPLATE_KEY = 'weekly_plan:caregiver';
export const CAREGIVER_REMINDER_TEMPLATE_KEY = 'reminder:caregiver';

const CAREGIVER_TEMPLATE_KEYS: readonly string[] = [
  CAREGIVER_WEEKLY_PLAN_TEMPLATE_KEY,
  CAREGIVER_REMINDER_TEMPLATE_KEY,
];

/** Whether this message is one Hale is sending to a caregiver rather than a parent. */
export function isCaregiverTemplateKey(templateKey: string): boolean {
  return CAREGIVER_TEMPLATE_KEYS.includes(templateKey);
}
