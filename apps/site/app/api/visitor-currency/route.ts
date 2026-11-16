import { NextResponse } from 'next/server';
import { visitorCurrencyFromHeaders } from '~/lib/billing/visitor-currency';

/**
 * JSON the marketing page can read without baking amounts: US → USD, else CAD.
 * Design owns the landing promo copy; this only names the currency.
 */
export async function GET(req: Request): Promise<Response> {
  const currency = visitorCurrencyFromHeaders(req.headers);
  return NextResponse.json({ currency });
}
