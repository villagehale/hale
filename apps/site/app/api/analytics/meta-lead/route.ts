import { NextResponse } from 'next/server';
import { metaEventSourceUrl, sendSiteMetaCapi } from '~/lib/analytics/meta-capi';
import { adsContextFromRequest } from '~/lib/billing/ads-context';

export const dynamic = 'force-dynamic';

const LEAD_EVENT_ID = /^lead_[a-f0-9]{32}$/;

/**
 * Lead for a consented tap that opens /text or an sms composer. The browser
 * pixel already used this event_id. No cookie is set. Email and phone are not
 * on the body; fbp and fbc come from the request when the pixel set them.
 */
export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 200) {
    return NextResponse.json(
      { status: 'refused' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  let eventId: string | null = null;
  try {
    const body = JSON.parse(text) as { event_id?: unknown };
    eventId =
      typeof body.event_id === 'string' && LEAD_EVENT_ID.test(body.event_id) ? body.event_id : null;
  } catch {
    eventId = null;
  }
  if (!eventId) {
    return NextResponse.json(
      { status: 'refused' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  const sourceUrl = metaEventSourceUrl(request.headers.get('referer'));
  const ads = adsContextFromRequest({
    cookieHeader: request.headers.get('cookie'),
    headers: request.headers,
  });
  if (!sourceUrl || !ads.fbp) {
    return NextResponse.json({ status: 'refused' }, { headers: { 'cache-control': 'no-store' } });
  }
  const status = await sendSiteMetaCapi({ eventName: 'Lead', eventId, sourceUrl, ads });
  return NextResponse.json({ status }, { headers: { 'cache-control': 'no-store' } });
}
