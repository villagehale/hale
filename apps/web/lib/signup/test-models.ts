import type { SignupConsentReader, SignupConsentReading } from './consent-reader';
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
