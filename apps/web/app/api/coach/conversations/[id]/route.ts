import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { loadConversationTranscript } from '~/lib/coach/history';
import type { TimelineMessage } from '~/lib/coach/conversation';

export const runtime = 'nodejs';

const idSchema = z.string().uuid();

export interface WebConversationTranscriptResponse {
  conversationId: string;
  turns: TimelineMessage[];
}

/**
 * GET /api/coach/conversations/:id — one Ask session's ordered transcript, for the
 * desktop rail's reopen. FAMILY-SCOPED inside loadConversationTranscript (rule #1): a
 * conversation that is unknown or belongs to another family resolves to null and
 * returns 404 — indistinguishable, so a foreign thread's existence is never revealed.
 * Auth() is the 401 gate. Continuation is elsewhere: /api/coach reopens by
 * conversationId — this route only reads history.
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const turns = await loadConversationTranscript(id);
  if (turns === null) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const body: WebConversationTranscriptResponse = { conversationId: id, turns };
  return NextResponse.json(body);
}
