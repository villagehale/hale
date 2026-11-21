import { foldWords } from '../parent-quote';
import type {
  CartDifference,
  CartRead,
  SignupTermsAmount,
  SignupTermsApprovedSession,
  SignupTermsTaxBound,
} from './types';

/**
 * VIL-715 · the one comparison between what the parent approved and what is in the cart.
 * Pure. Any difference stops the run before the card is used, and a field it needs that
 * the cart did not show never passes. A cart that reads lower than the approval also
 * stops: the ticket says any difference, and a lower total can mean the wrong class.
 */
export type CartForCompare = CartRead & {
  totalCents: number | null;
  taxCents: number | null;
  feesCents: number | null;
  currency: string | null;
};

const NAIVE_START = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;
const OFFSET_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A bound start as wall-clock date and time in the portal's zone, or null when unreadable. */
export function boundWallClock(
  startsAt: string,
  timeZone: string,
): { date: string; time: string | null } | null {
  const raw = startsAt.trim();
  const naive = NAIVE_START.exec(raw);
  if (naive?.[1]) return { date: naive[1], time: naive[2] ?? null };
  if (!OFFSET_START.test(raw)) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

function firstName(name: string): string {
  return foldWords(name).split(' ')[0] ?? '';
}

function comparesProgram(
  bound: SignupTermsApprovedSession,
  cart: CartForCompare,
): CartDifference | null {
  if (cart.provider_course_id !== null) {
    const shown = foldWords(cart.provider_course_id);
    return bound.program.courseIds.some((id) => foldWords(id) === shown) ? null : 'session';
  }
  if (cart.session_label === null) return 'unread';
  return foldWords(cart.session_label) === foldWords(bound.program.name) ? null : 'session';
}

function comparesWhen(
  bound: SignupTermsApprovedSession,
  cart: CartForCompare,
  timeZone: string,
): CartDifference | null {
  const wall = boundWallClock(bound.startsAt, timeZone);
  if (wall === null || cart.session_date === null) return 'unread';
  if (cart.session_date !== wall.date) return 'session';
  if (cart.session_time === null || wall.time === null) return bound.sharesDate ? 'session' : null;
  return cart.session_time === wall.time ? null : 'session';
}

/** The tax allowed on one rate: this province's, within a cent, or up to the ceiling. */
function taxFits(rate: number, tax: number, bound: SignupTermsTaxBound): boolean {
  if (bound.kind === 'rate') {
    return Math.abs(tax - Math.round((rate * bound.basisPoints) / 10_000)) <= 1;
  }
  return tax * 10_000 <= rate * bound.basisPoints;
}

/** The highest total this amount can pass with: the rate, tax included. */
export function mostAllowedCents(amount: SignupTermsAmount): number {
  if (amount.kind === 'free') return 0;
  if (amount.kind === 'ceiling') return amount.cents;
  const top = Math.max(...amount.cents);
  const withTax =
    amount.plusTax === null
      ? top
      : top +
        (amount.plusTax.kind === 'rate'
          ? Math.round((top * amount.plusTax.basisPoints) / 10_000) + 1
          : Math.floor((top * amount.plusTax.basisPoints) / 10_000));
  return amount.limitCents === null ? withTax : Math.min(withTax, amount.limitCents);
}

function comparesFinalExact(
  amount: Extract<SignupTermsAmount, { kind: 'exact' }>,
  cart: CartForCompare,
  total: number,
): CartDifference | null {
  if (cart.feesCents === null) return 'unread';
  const gap = cart.feesCents > 0 ? 'fees' : 'price';
  if (amount.limitCents !== null && total > amount.limitCents) return 'price';
  if (amount.plusTax === null) {
    if (cart.feesCents > 0) return 'fees';
    return amount.cents.includes(total) ? null : 'price';
  }
  if (cart.taxCents === null) return 'unread';
  const rate = amount.cents.find((cents) => cents + (cart.taxCents as number) === total);
  if (rate === undefined || cart.feesCents > 0) return gap;
  return taxFits(rate, cart.taxCents, amount.plusTax) ? null : 'price';
}

function comparesAmount(
  amount: SignupTermsAmount,
  cart: CartForCompare,
  stage: 'cart' | 'final',
): CartDifference | null {
  const total = cart.totalCents;
  if (total === null) return 'unread';
  if (amount.kind === 'free') return total === 0 ? null : 'price';
  if (cart.currency === null || amount.currency === null) return 'unread';
  if (cart.currency !== amount.currency) return 'price';
  if (stage === 'cart') return total > 0 && total <= mostAllowedCents(amount) ? null : 'price';
  if (amount.kind === 'ceiling') return total <= amount.cents ? null : 'price';
  return comparesFinalExact(amount, cart, total);
}

export function compareCart(
  bound: SignupTermsApprovedSession,
  cart: CartForCompare,
  who: { childFirstName: string; timeZone: string },
  stage: 'cart' | 'final',
): CartDifference[] {
  const differences: (CartDifference | null)[] = [
    comparesProgram(bound, cart),
    comparesWhen(bound, cart, who.timeZone),
    cart.participant_first_name === null
      ? 'unread'
      : firstName(cart.participant_first_name) === firstName(who.childFirstName)
        ? null
        : 'kid',
    cart.line_count === null || cart.quantity === null
      ? 'unread'
      : cart.line_count === 1 && cart.quantity === 1
        ? null
        : 'quantity',
    comparesAmount(bound.amount, cart, stage),
  ];
  return [...new Set(differences.filter((item): item is CartDifference => item !== null))];
}
