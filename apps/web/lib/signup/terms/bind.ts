import type { AgeEligibility } from '~/lib/registration/sequence/prepare';
import { boundWallClock, hasUnstatedPrice, mostAllowedCents } from './cart';
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
  | { kind: 'outside_band' };

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
): SignupTermsAmount {
  const cents = ratesFor(input.shown.residency, session.rates).map((row) => row.cents);
  if (cents.length === 0) return { kind: 'unstated' };
  if (cents.every((value) => value === 0)) return { kind: 'free' };
  return {
    kind: 'exact',
    cents,
    currency: input.shown.currency,
    plusTax: session.tax === 'plus_tax' ? input.taxBound : null,
  };
}

function holdFor(
  input: BindInput,
  picked: SignupTermsShown['sessions'],
  sessions: readonly SignupTermsApprovedSession[],
): SignupTermsHold | null {
  if (input.shown.priorChargeUnknown) return 'prior_charge_unknown';
  if (picked.some((session) => session.source === 'site_option')) return 'site_option';
  // Hale never decides a child has met this. The parent, who knows, finishes at checkout.
  if (input.shown.prerequisite.required === 'yes') return 'prerequisite_unconfirmed';
  if (input.ageFit === 'unknown') return 'age_unconfirmed';
  return hasUnstatedPrice(sessions) ? 'price_unstated' : null;
}

export function bindApproval(input: BindInput): BindResult {
  if (input.askedMessageId === null) return { kind: 'terms_unsent' };
  if (input.ageFit === 'outside_band') return { kind: 'outside_band' };
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
    const shownSession = input.shown.sessions.find((item) => item.sessionId === choiceId);
    // A session the text never stated has no terms to say yes to.
    if (!session || !shownSession) return { kind: 'terms_unsent' };
    picked.push(shownSession);
    const amount = amountFor(shownSession, input);
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
      // A priced session beside an unpriced one lends it no limit: the whole pick is unpayable.
      maxCents: hasUnstatedPrice(sessions)
        ? 0
        : Math.max(...sessions.map((session) => mostAllowedCents(session.amount))),
      countsAgainstSeason: input.shown.countsAgainstSeason,
      seasonKey: null,
      hold: holdFor(input, picked, sessions),
    },
  };
}
