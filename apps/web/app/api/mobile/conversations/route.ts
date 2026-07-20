import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { loadConversations } from '~/lib/coach/history';
import type { MobileConversationsResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/conversations — the family's Ask sessions, newest-active first, for
 * the native history rail. Each row carries a server-derived title (first live user
 * turn) + count + last-active stamp; the raw transcript never rides this list. Auth()
 * is the 401 gate — the loader re-resolves the family from the same session and owns
 * the family scope (rule #1), so this route never touches the DB.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const conversations = await loadConversations();

  const body: MobileConversationsResponse = { conversations };
  return NextResponse.json(body);
}
