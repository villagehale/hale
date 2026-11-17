import { type BillingCurrency, currencyFromIpCountry, serverCheckoutCurrency } from '@hale/types';
import { headers } from 'next/headers';

/**
 * US → USD; every other country and a missing geo header → CAD.
 * With CHECKOUT_SERVER_CURRENCY_ENABLED exactly `true`, only US and CA resolve.
 * Anything else is null so a client is not told to pay CAD.
 */
export function visitorCurrencyFromHeaders(headerList: {
  get(name: string): string | null;
}): BillingCurrency | null {
  const country = headerList.get('x-vercel-ip-country');
  if (process.env.CHECKOUT_SERVER_CURRENCY_ENABLED === 'true') {
    return serverCheckoutCurrency(country);
  }
  return currencyFromIpCountry(country);
}

export async function visitorCurrency(): Promise<BillingCurrency> {
  return (await visitorCheckoutCurrency()) ?? 'CAD';
}

/** Null when the server-currency flag is on and geo is not US or CA. */
export async function visitorCheckoutCurrency(): Promise<BillingCurrency | null> {
  return visitorCurrencyFromHeaders(await headers());
}
