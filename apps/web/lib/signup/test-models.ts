import type { SignupConsentReader, SignupConsentReading } from './consent-reader';
import type { SignupOfferFacts, SignupOfferWriter } from './offer-writer';
import type { SignupOutcomeFacts, SignupOutcomeWriter } from './outcome-reply';

/**
 * Test stand-ins for the two models. Tests only: the stub reader plays the
 * model's verdict for fixture messages; production never matches words.
 */
export function stubConsentReader(
  verdictFor: (text: string) => SignupConsentReading | null = (text) =>
    /sign us up/i.test(text) ? { verdict: 'consent', sessionId: null } : { verdict: 'unrelated' },
): SignupConsentReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async read(input) {
      calls.push(input.text);
      return verdictFor(input.text);
    },
  };
}

/** Echoes the structured facts so tests assert on what the reply model was given. */
export function echoOutcomeWriter(): SignupOutcomeWriter & { facts: SignupOutcomeFacts[] } {
  const facts: SignupOutcomeFacts[] = [];
  return {
    facts,
    async write(input) {
      facts.push(input);
      return renderEcho(input);
    },
  };
}

/** Returns a unique line that still carries the URL and a session Hale saw. */
export function echoOfferWriter(): SignupOfferWriter & { facts: SignupOfferFacts[] } {
  const facts: SignupOfferFacts[] = [];
  return {
    facts,
    async write(input) {
      facts.push(input);
      const session = input.sessions[0]?.label ?? 'session';
      return `From the ${input.source}: ${session} at ${input.registrationUrl} — want me to try?`;
    },
  };
}

export function renderEcho(facts: SignupOutcomeFacts): string {
  return [
    `outcome=${facts.outcome}`,
    `reason=${facts.reason ?? ''}`,
    `confirmed=${facts.confirmed}`,
    `session=${facts.sessionLabel ?? ''}`,
    `prefilled=${facts.prefilled.join(',')}`,
    `link=${facts.link}`,
  ].join(' ');
}
