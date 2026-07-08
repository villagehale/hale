import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadMessages } from '~/lib/messages/queries';
import type { MobileMessagesResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/messages — "Hale's notes to you": the family's daily digests +
 * the action lifecycle a parent should see, newest first. A 13+ child's raw
 * action content is redacted inside loadMessages (rule #1). This route never
 * touches the DB. Auth() is the 401 gate — the loader re-resolves the family from
 * the same session, so an unauthenticated caller gets 401, never an empty payload.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const messages = await loadMessages();

  const body: MobileMessagesResponse = { messages };
  return NextResponse.json(body);
}
