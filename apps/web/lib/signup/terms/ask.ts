import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { SPOT_PORTAL_HOSTS } from '~/lib/channel/spots/url';
import type { PrepChild } from '~/lib/registration/sequence/prepare';
import { REGISTRATION_TIME_ZONE } from '~/lib/registration/verify-window';
import type { PlanReadTerms } from '../plan/reader';
import type { PlanReplyTerms } from '../plan/writer';
import type { SignupSession } from '../types';
import { ratesFor } from './bind';
import { hasUnstatedPrice } from './cart';
import { residencyFor } from './evaluate';
import { type ProgramTermsDeps, liveProgramTermsDeps, readProgramTerms } from './read-page';
import { priorChargeUnknown } from './store';
import {
  ONTARIO_TAX_BASIS_POINTS,
  type SignupTermsApproved,
  type SignupTermsShown,
  type SignupTermsTaxBound,
  TAX_CEILING_BASIS_POINTS,
} from './types';

/**
 * VIL-715 · what Hale checks before it asks: the page, the child against the page, an
 * earlier try that may have charged, and when this ask runs. With pre-flight on every ask
 * is a plan, so there is one checkout path to hold to the parent's yes.
 */

/** The portal's own zone, else the parent's, else the registration default. */
export function termsTimeZone(host: string, parentZone: string | null): string {
  const portal = SPOT_PORTAL_HOSTS[host];
  if (portal) return portal.timeZone;
  return parentZone && parentZone !== 'UTC' ? parentZone : REGISTRATION_TIME_ZONE;
}

/** The registry's two portals are in Ontario. Elsewhere the province is not known. */
export function taxBoundFor(host: string): SignupTermsTaxBound {
  return SPOT_PORTAL_HOSTS[host]
    ? { kind: 'rate', basisPoints: ONTARIO_TAX_BASIS_POINTS }
    : { kind: 'ceiling', basisPoints: TAX_CEILING_BASIS_POINTS };
}

function currencyFromPostal(postal: string | null): SignupTermsShown['currency'] {
  const code = (postal ?? '').replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]\d[A-Z]/.test(code)) return 'cad';
  if (/^\d{5}/.test(code)) return 'usd';
  return null;
}

export type TermsAsk =
  | { kind: 'outside_band'; ageBand: string | null }
  | {
      kind: 'ask';
      shown: SignupTermsShown;
      writer: PlanReplyTerms;
      opensAt: Date;
      alreadyOpen: boolean;
    };

export async function prepareTermsAsk(
  database: Database,
  input: {
    familyId: string;
    child: PrepChild;
    parentZone: string | null;
    activityKey: string;
    registrationUrl: string;
    host: string;
    sessions: readonly SignupSession[];
    /** When the parent or page said registration opens. Null when nobody did. */
    statedOpensAt: Date | null;
    now: Date;
  },
  deps: ProgramTermsDeps = {},
): Promise<TermsAsk> {
  const [family] = await database
    .select({ postalCode: schema.families.postalCode })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  const postal = family?.postalCode ?? null;
  const residency = residencyFor(input.host, postal);
  const live = liveProgramTermsDeps(() => resolveReplyClient(undefined));
  const read = await readProgramTerms(
    {
      registrationUrl: input.registrationUrl,
      child: input.child,
      now: input.now,
      timeZone: termsTimeZone(input.host, input.parentZone),
      residency,
    },
    { fetchBody: deps.fetchBody ?? live.fetchBody, reader: deps.preflightReader ?? live.reader },
  );
  if (read.age.fit === 'outside_band') return { kind: 'outside_band', ageBand: read.age.band };

  const stated = input.statedOpensAt;
  const future = stated && stated.getTime() > input.now.getTime() ? stated : null;
  const opensAt = future ?? (stated ? input.now : (read.pageOpensAt ?? input.now));
  const shown: SignupTermsShown = {
    v: 1,
    read: read.read,
    program: read.program,
    residency,
    age: { fit: read.age.fit, band: read.age.band, rule: read.age.rule },
    prerequisite: read.prerequisite,
    refund: read.refund,
    currency: read.currency ?? currencyFromPostal(postal),
    // An ask with a stated open has no season limit today. Every other ask does.
    countsAgainstSeason: stated === null,
    priorChargeUnknown: await priorChargeUnknown(database, {
      familyId: input.familyId,
      childId: input.child.id,
      activityKey: input.activityKey,
    }),
    sessions: input.sessions.map((session) => {
      if (read.rates.length > 0) {
        return {
          sessionId: session.id,
          rates: read.rates,
          tax: read.tax,
          source: read.read === 'course_model' ? 'course_model' : 'page_quote',
        };
      }
      const offered = session.priceCents !== null && session.priceCents >= 0;
      return {
        sessionId: session.id,
        rates: offered ? [{ rate: 'flat', cents: session.priceCents as number }] : [],
        tax: 'unknown',
        source: 'offer',
      };
    }),
  };
  const alreadyOpen = future === null && (stated !== null || read.pageOpensAt === null);
  return {
    kind: 'ask',
    shown,
    writer: writerTerms(shown, { runsNow: alreadyOpen }),
    opensAt,
    alreadyOpen,
  };
}

/** What the writer may say about these terms. */
export function writerTerms(
  shown: SignupTermsShown,
  extra: { runsNow?: boolean; hold?: SignupTermsApproved['hold'] } = {},
): PlanReplyTerms {
  const seen = new Set<string>();
  const rates = shown.sessions
    .flatMap((session) => ratesFor(shown.residency, session.rates))
    .filter((row) => {
      const key = `${row.rate}:${row.cents}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const taxes = new Set(shown.sessions.map((session) => session.tax));
  const [tax] = taxes;
  const priceMissing =
    rates.length === 0 ||
    shown.sessions.some((session) => ratesFor(shown.residency, session.rates).length === 0);
  const unread: PlanReplyTerms['unread'] = [
    ...(shown.read === 'unread' ? (['page'] as const) : []),
    ...(shown.refund === null ? (['refund'] as const) : []),
    ...(shown.age.fit === 'unknown' ? (['age'] as const) : []),
    ...(shown.prerequisite.required === 'unknown' ? (['prerequisite'] as const) : []),
    ...(priceMissing ? (['price'] as const) : []),
  ];
  return {
    free: !priceMissing && rates.every((row) => row.cents === 0),
    rates,
    residency: shown.residency,
    tax: taxes.size === 1 && tax ? tax : 'unknown',
    refund: shown.refund?.quote ?? null,
    ageFit: shown.age.fit,
    ageBand: shown.age.band,
    prerequisite: shown.prerequisite,
    priorChargeUnknown: shown.priorChargeUnknown,
    unread,
    ...extra,
  };
}

/** What the plan reader is told the ask stated. */
export function planReadTerms(
  shown: SignupTermsShown,
  context: { prerequisiteAsked: boolean },
): PlanReadTerms {
  return {
    sessionPrices: shown.sessions.map((session) => ({
      sessionId: session.sessionId,
      cents: ratesFor(shown.residency, session.rates).map((row) => row.cents),
    })),
    freeSessionIds: shown.sessions
      .filter(
        (session) =>
          session.rates.length > 0 &&
          ratesFor(shown.residency, session.rates).every((row) => row.cents === 0),
      )
      .map((session) => session.sessionId),
    prerequisiteRequired: shown.prerequisite.required === 'yes',
    prerequisiteQuote: shown.prerequisite.quote,
    prerequisiteAsked: context.prerequisiteAsked,
  };
}

export function childFor(row: {
  id: string;
  dateOfBirth: string;
  dobPrecision: string;
}): PrepChild {
  return { id: row.id, dateOfBirth: row.dateOfBirth, dobPrecision: row.dobPrecision };
}

/**
 * The price the parent bound, for a writer to say. The maximum carries a tax allowance.
 * Null when a session has no stated price: there is no figure to say.
 */
export function boundPriceCents(approved: SignupTermsApproved): number | null {
  const prices = approved.sessions.flatMap(({ amount }) =>
    amount.kind === 'unstated' ? [] : amount.kind === 'free' ? [0] : amount.cents,
  );
  return hasUnstatedPrice(approved.sessions) ? null : Math.max(...prices);
}
