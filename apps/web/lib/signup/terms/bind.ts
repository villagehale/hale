import type { AgeEligibility } from '~/lib/registration/sequence/prepare';
import { boundWallClock, mostAllowedCents } from './cart';
import type {
  SignupTermsAmount,
  SignupTermsApproved,
  SignupTermsApprovedSession,
  SignupTermsHold,
  SignupTermsShown,
  SignupTermsTaxBound,
} from './types';

/**
 * VIL-715 · what a parent's yes binds. Pure: written from the terms that were shown, never
 * from a model's figure. Nothing binds until those terms are known to have reached them. A
 * session with a stated price binds that price and nothing else.
 */
export interface BindInput {
  shown: SignupTermsShown;
  /** The row that carried the offer's text. Null: no send of it is known to have gone. */
  askedMessageId: string | null;
  sessions: readonly { id: string; label: string; startsAt: string }[];
  /** The offer's own name for the class: the program name when the page gave none. */
  activityLabel: string | null;
  choiceIds: readonly string[];
  /** Money the parent wrote in this yes. Only a session with no stated rate reads it. */
  ceilingCents: number | null;
  /** The parent's own words confirmed the prerequisite. Null when they said nothing about it. */
  prerequisiteMet: boolean | null;
  /** The age check run again at this yes. */
  ageFit: AgeEligibility;
  /** The tax a `plus_tax` rate may add. */
  taxBound: SignupTermsTaxBound;
  timeZone: string;
}

export type BindResult =
  | { kind: 'bound'; approved: SignupTermsApproved }
  /** The offer's text is not known to have reached them: send the terms, bind nothing. */
  | { kind: 'terms_unsent' }
  /** A date of birth given since the ask puts the child outside the band. */
  | { kind: 'outside_band' }
  /** One question, and the offer stays open. */
  | { kind: 'clarify'; reason: 'prerequisite' | 'no_amount' };

/** The rates this family can be charged: their own when residency is known, else all. */
export function ratesFor(
  residency: SignupTermsShown['residency'],
  rates: SignupTermsShown['sessions'][number]['rates'],
): SignupTermsShown['sessions'][number]['rates'] {
  const usable =
    residency === 'unknown'
      ? rates
      : rates.filter((row) => row.rate === 'flat' || row.rate === residency);
  return usable.length > 0 ? usable : rates;
}

function amountFor(
  session: SignupTermsShown['sessions'][number],
  input: BindInput,
): SignupTermsAmount | { clarify: 'no_amount' } {
  const currency = input.shown.currency;
  const ceiling = input.ceilingCents;
  const cents = ratesFor(input.shown.residency, session.rates).map((row) => row.cents);
  if (cents.length === 0) {
    return ceiling === null
      ? { clarify: 'no_amount' }
      : { kind: 'ceiling', cents: ceiling, currency };
  }
  if (cents.every((value) => value === 0)) return { kind: 'free' };
  return {
    kind: 'exact',
    cents,
    currency,
    plusTax: session.tax === 'plus_tax' ? input.taxBound : null,
  };
}

function holdFor(input: BindInput, picked: SignupTermsShown['sessions']): SignupTermsHold | null {
  if (input.shown.priorChargeUnknown) return 'prior_charge_unknown';
  if (picked.some((session) => session.source === 'site_option')) return 'site_option';
  return input.ageFit === 'unknown' ? 'age_unconfirmed' : null;
}

export function bindApproval(input: BindInput): BindResult {
  if (input.askedMessageId === null) return { kind: 'terms_unsent' };
  if (input.ageFit === 'outside_band') return { kind: 'outside_band' };
  const needsPrerequisite = input.shown.prerequisite.required === 'yes';
  if (needsPrerequisite && input.prerequisiteMet !== true) {
    return { kind: 'clarify', reason: 'prerequisite' };
  }
  const wall = new Map(
    input.sessions.map((session) => [
      session.id,
      boundWallClock(session.startsAt, input.timeZone)?.date ?? null,
    ]),
  );
  const sessions: SignupTermsApprovedSession[] = [];
  const picked: SignupTermsShown['sessions'] = [];
  for (const choiceId of input.choiceIds) {
    const session = input.sessions.find((item) => item.id === choiceId);
    if (!session) return { kind: 'clarify', reason: 'no_amount' };
    const shownSession = input.shown.sessions.find((item) => item.sessionId === choiceId);
    // A session the text never stated has no terms to say yes to, and no ceiling stands in.
    if (!shownSession) return { kind: 'terms_unsent' };
    picked.push(shownSession);
    const amount = amountFor(shownSession, input);
    if ('clarify' in amount) return { kind: 'clarify', reason: amount.clarify };
    const date = wall.get(session.id) ?? null;
    sessions.push({
      sessionId: session.id,
      program: {
        courseIds: input.shown.program.courseIds,
        name: input.shown.program.name ?? input.activityLabel,
      },
      startsAt: session.startsAt,
      sharesDate:
        date === null ||
        input.sessions.some((other) => other.id !== session.id && wall.get(other.id) === date),
      amount,
    });
  }
  return {
    kind: 'bound',
    approved: {
      v: 1,
      sessions,
      quantity: 1,
      maxCents: Math.max(...sessions.map((session) => mostAllowedCents(session.amount))),
      prerequisiteConfirmed: needsPrerequisite ? true : null,
      countsAgainstSeason: input.shown.countsAgainstSeason,
      seasonKey: null,
      hold: holdFor(input, picked),
    },
  };
}
