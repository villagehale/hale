import { NextResponse } from 'next/server';
import { captureConsentChoice } from '~/lib/analytics/server-capture';
import { isConsentChoice } from '~/lib/site/consent';

export const dynamic = 'force-dynamic';

/**
 * Counts Accept / No thanks. No cookie is set. The body is only the choice.
 * PostHog is called from captureConsentChoice, which stays dark until
 * FUNNEL_ATTRIBUTION_ENABLED is exactly true.
 */
export async function POST(request: Request): Promise<Response> {
  const choice = await readChoice(request);
  if (!choice) return NextResponse.json({ error: 'invalid_choice' }, { status: 400 });
  const status = await captureConsentChoice(choice);
  return NextResponse.json({ status }, { headers: { 'cache-control': 'no-store' } });
}

async function readChoice(request: Request): Promise<'granted' | 'denied' | null> {
  const text = await request.text();
  if (text.length > 200) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const choice = (parsed as { choice?: unknown }).choice;
    return isConsentChoice(choice) ? choice : null;
  } catch {
    return null;
  }
}
