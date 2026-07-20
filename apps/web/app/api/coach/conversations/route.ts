import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { type ConversationSummary, loadConversations } from '~/lib/coach/history';

export const runtime = 'nodejs';

export interface WebConversationsResponse {
  conversations: ConversationSummary[];
}

/**
 * GET /api/coach/conversations — the family's Ask sessions, newest-active first, for
 * the desktop history rail's client refresh after a send. Each row carries a
 * server-derived title (first live user turn) + count + last-active stamp; the raw
 * transcript never rides this list. Auth() is the 401 gate — the loader re-resolves
 * the family from the same session and owns the family scope (rule #1), so this
 * route never touches the DB directly.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const conversations = await loadConversations();
  const body: WebConversationsResponse = { conversations };
  return NextResponse.json(body);
}
