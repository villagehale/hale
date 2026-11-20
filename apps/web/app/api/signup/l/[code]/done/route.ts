import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { takeoverLinkEnabled } from '~/lib/signup/takeover/flag';
import { finishTakeover } from '~/lib/signup/takeover/store';

export const runtime = 'nodejs';

const PRIVATE = { 'Cache-Control': 'no-store' } as const;

/**
 * POST /api/signup/l/:code/done — VIL-718. The parent finished the step in Hale's browser.
 * Spends the takeover card (single use) and lets the next minute's sweep pick the same
 * browser session back up (`finishTakeover`, which writes the audit row). A card that is
 * spent, expired, unknown, or whose plan already ended is gone: nothing is resumed.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  if (!takeoverLinkEnabled()) {
    return NextResponse.json({ error: 'gone' }, { status: 404, headers: PRIVATE });
  }
  const { code } = await context.params;
  const finished = await finishTakeover(db(), { code, now: new Date() });
  if (!finished.ok) {
    return NextResponse.json({ error: 'gone' }, { status: 404, headers: PRIVATE });
  }
  return NextResponse.json({ done: true }, { headers: PRIVATE });
}
