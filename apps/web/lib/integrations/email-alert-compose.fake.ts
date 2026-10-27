import type { EmailAlertFacts } from './email-alert-compose';

/**
 * A deterministic stand-in for the model, for MECHANICS tests only (send, ledger, offer,
 * booking, going). It is not Hale's copy and nothing in production imports it; quality
 * is the eval suite's job (rule #8). It echoes the facts so a test can see which ones
 * reached the writer.
 */
export function fakeEmailAlertText(facts: EmailAlertFacts): string {
  const parts = [`[${facts.kind}]`];
  if (facts.from) parts.push(facts.from);
  if (facts.what) parts.push(facts.what);
  const when = facts.when.now ?? facts.when.was;
  if (when) parts.push(`${when.date} ${when.time}`);
  if (facts.where) parts.push(`at ${facts.where}`);
  if (facts.going !== null) parts.push(`with ${facts.going} other Hale families`);
  if (facts.categoryOnly) parts.push('(details kept out)');
  if (facts.ask) parts.push(`ask:${facts.ask}`);
  if (facts.passport) parts.push(`passport:${facts.passport.activity}`);
  return parts.join(' ');
}

export const fakeEmailAlertWriter = {
  composeText: async (facts: EmailAlertFacts) => fakeEmailAlertText(facts),
  language: async () => 'en' as const,
  // Screens, open by default so a mechanics test reaches the send; a test that is about a
  // screen overrides the one it is about.
  parentAddresses: async (): Promise<readonly string[]> => [],
  calendarMirrored: async () => false,
  kidRelevance: async () => 'kid' as const,
};
