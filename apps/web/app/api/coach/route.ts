import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { askHale } from '~/lib/coach/agent';
import { NOTE_KEY_RE } from '~/lib/coach/note-key';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { enforceRateLimit } from '~/lib/rate-limit/apply';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the agent reads the skill file off disk and calls the Anthropic
// SDK — neither works on the edge runtime.
export const runtime = 'nodejs';

const bodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  /** Continue an existing thread; omitted/null starts a fresh one. */
  conversationId: z.string().uuid().optional(),
  /** The intent chip the parent tapped, if any. */
  intent: z.string().trim().min(1).max(200).optional(),
  /** The child the parent focused the conversation on (per-child chip), if any. */
  focusedChildId: z.string().uuid().optional(),
  /** Anchor this reply to a Hale note's persistent thread (mobile Messages reply). */
  noteKey: z.string().trim().regex(NOTE_KEY_RE).optional(),
  /** The redacted note view the reply grounds on — seeds the note's content into the
   * agent context (rule #2: structured, no prompt strings). Bounded; never re-fetched
   * server-side, so it can only be the app's already-redacted note (rule #1). */
  sourceNote: z
    .object({
      eyebrow: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(4000),
      when: z.string().trim().min(1).max(100),
    })
    .optional(),
});

/**
 * POST /api/coach — a signed-in parent asking Ask Hale, now a stateful agent.
 *
 * Auth is the spend gate. When auth is unconfigured (dev preview) we refuse with
 * 501 and NEVER run the agent — no spend, no guessing a family. Signed-out → 401.
 * Family-scoped (rule #1): the agent only ever sees the CALLER's family — its
 * children (teen detail redacted), memory, and conversation thread. The acting
 * parent's user id is the audit actor (rule #6 / PIPEDA right-to-access).
 */
export async function POST(req: Request) {
  if (!authConfigured()) {
    return NextResponse.json(
      { error: 'auth_required', detail: 'sign in to ask Hale' },
      { status: 501 },
    );
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_question' }, { status: 400 });
  }

  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return NextResponse.json({ error: 'no_family_for_user' }, { status: 403 });
  }
  const actorUserId = await resolveUserIdForUser(externalAuthId, database);
  if (!actorUserId) {
    return NextResponse.json({ error: 'no_user_for_caller' }, { status: 403 });
  }

  // Per-user cap before the billable agent run — caps one parent's LLM spend.
  const limited = await enforceRateLimit('coach', actorUserId);
  if (limited) return limited;

  // Stream the answer as newline-delimited JSON events so it renders token-by-token
  // (perceived latency is output-length-bound). Events: {type:'step',step} as each
  // model round-trip begins, {type:'tool_call',name} / {type:'tool_result',name,ok,
  // preview} as the guarded tool loop works (rule #1: name + ok + a content-free
  // preview only — never args or raw tool output), {type:'delta',text} as the final
  // answer streams, {type:'reset'} when an intermediate tool turn streamed text that
  // is NOT the answer (drop it), then a terminal {type:'done',conversationId,
  // actionIntents}. A failure mid-run emits {type:'error'} so the client shows its
  // retry state rather than a dangling stream. The agent run (persistence, audit,
  // action-intent detection, trace — rule #1/#4/#6) is unchanged; only the transport
  // differs.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const { conversationId, actionIntents } = await askHale(
          {
            familyId,
            question: parsed.data.question,
            intent: parsed.data.intent ?? null,
            conversationId: parsed.data.conversationId ?? null,
            focusedChildId: parsed.data.focusedChildId ?? null,
            actor: actorUserId,
            noteKey: parsed.data.noteKey ?? null,
            sourceNote: parsed.data.sourceNote ?? null,
          },
          database,
          undefined,
          {
            onTextDelta: (text) => send({ type: 'delta', text }),
            onTurnReset: () => send({ type: 'reset' }),
            onStep: (step) => send({ type: 'step', step }),
            // Rule #1: forward only the harness's redacted payloads — name (no args)
            // on the call, name + ok + content-free preview (no raw output) on the
            // result. The route never re-derives these from tool data.
            onToolCall: ({ name }) => send({ type: 'tool_call', name }),
            // The optional `card` is the ONE whitelisted display payload (rule #1):
            // a closed union of connector rows the tool declared safe to show, never
            // raw output. Forwarded verbatim from the harness, which built it.
            onToolResult: ({ name, ok, preview, card }) =>
              send({ type: 'tool_result', name, ok, preview, ...(card ? { card } : {}) }),
          },
        );
        send({ type: 'done', conversationId, actionIntents });
      } catch {
        send({ type: 'error' });
      } finally {
        // Serverless flush: the Vercel function is short-lived, so buffered spans
        // must be sent before it returns or the trace is dropped (rule #8).
        await flushTelemetry();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
