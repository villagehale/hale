/**
 * Parent-facing sentences for a partnership booking (VIL-397).
 *
 * The booked line may leave only when the connector confirmed. The failed
 * line names that nothing was signed up. Nothing here is imported by the
 * runner: the send path keeps the earlier locked completed line until a
 * caller passes a confirmation. Flags stay off.
 */

export const PARTNERSHIP_BOOKED_LINE_TODO =
  'You\'re signed up for {session} with {provider}. Their confirmation is {ref}. Say "details" if you want what to bring.';

export const PARTNERSHIP_BOOKED_LINE_FR =
  'C\'est fait pour {session} avec {provider}. Leur confirmation: {ref}. Dis "details" pour savoir quoi apporter.';

export const PARTNERSHIP_FAILED_LINE_TODO =
  "I couldn't finish {session} with {provider}, so nothing is signed up. Here's the page if you'd like to do it yourself: {link}";

export const PARTNERSHIP_FAILED_LINE_FR =
  "Je n'ai pas pu terminer {session} avec {provider}, donc rien n'est fait. Voici la page si tu veux le faire toi-meme: {link}";

function fill(pattern: string, slots: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '');
}

/** Booked copy leaves only with a connector confirmation and a reference. */
export function partnershipBookedLine(input: {
  language: 'en' | 'fr';
  session: string;
  provider: string;
  ref: string;
  confirmed: boolean;
}): { body: string; mayLeave: boolean } {
  const pattern =
    input.language === 'fr' ? PARTNERSHIP_BOOKED_LINE_FR : PARTNERSHIP_BOOKED_LINE_TODO;
  const body = fill(pattern, {
    session: input.session,
    provider: input.provider,
    ref: input.ref,
  });
  const mayLeave =
    input.confirmed &&
    input.ref.trim().length > 0 &&
    input.session.trim().length > 0 &&
    input.provider.trim().length > 0 &&
    !body.includes('{');
  return { body, mayLeave };
}

export function partnershipFailedLine(input: {
  language: 'en' | 'fr';
  session: string;
  provider: string;
  link: string;
}): { body: string; mayLeave: boolean } {
  const pattern =
    input.language === 'fr' ? PARTNERSHIP_FAILED_LINE_FR : PARTNERSHIP_FAILED_LINE_TODO;
  const body = fill(pattern, {
    session: input.session,
    provider: input.provider,
    link: input.link,
  });
  const mayLeave = input.link.trim().length > 0 && !body.includes('{');
  return { body, mayLeave };
}
