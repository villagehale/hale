import { headers } from 'next/headers';
import { type BillingCurrency, currencyFromIpCountry } from '@hale/types';

/** US → USD; every other country and a missing geo header → CAD. */
export function visitorCurrencyFromHeaders(headerList: {
  get(name: string): string | null;
}): BillingCurrency {
  return currencyFromIpCountry(headerList.get('x-vercel-ip-country'));
}

export async function visitorCurrency(): Promise<BillingCurrency> {
  try {
    return visitorCurrencyFromHeaders(await headers());
  } catch {
    // Unit renders have no request. Same fallback as a missing geo header.
    return 'CAD';
  }
}
