import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { writePlanAudit } from '~/lib/signup/plan/store';
import { takeoverLinkEnabled } from '~/lib/signup/takeover/flag';
import { takeoverLiveView } from '~/lib/signup/takeover/store';

export const runtime = 'nodejs';

const PRIVATE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

/**
 * POST /api/signup/l/:code/live — VIL-718. The live view behind an open takeover card, for
 * the card's own page after the parent taps open. The raw code is the auth: no Hale session.
 * A POST, so a link-preview fetcher (a GET) never receives it. Nothing is spent here: the
 * parent may open it again until they tap done or the card closes. The live view is
 * credential-grade: never logged, never audited; the audit row carries the host and the step.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  if (!takeoverLinkEnabled()) {
    return NextResponse.json({ error: 'gone' }, { status: 404, headers: PRIVATE });
  }
  const { code } = await context.params;
  const opened = await takeoverLiveView(db(), code, new Date());
  if (!opened.ok) {
    return NextResponse.json({ error: 'gone' }, { status: 404, headers: PRIVATE });
  }
  await writePlanAudit(db(), {
    familyId: opened.link.familyId,
    actor: opened.link.parentUserId,
    offerId: opened.link.offerId,
    after: {
      step: 'plan_takeover_opened',
      purpose: opened.link.purpose.takeover ?? null,
      host: opened.link.providerHost,
    },
  });
  return NextResponse.json({ liveViewUrl: opened.liveViewUrl }, { headers: PRIVATE });
}
