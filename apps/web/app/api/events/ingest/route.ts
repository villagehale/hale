import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '~/lib/db';
import { pipelineClient } from '~/lib/pipeline/client';
import { ingestEvent } from '~/lib/pipeline/ingest';
import { INBOUND_SIGNATURE_HEADER, verifyInboundSignature } from '~/lib/pipeline/verify-secret';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the pipeline reads its skill files off disk and calls the
// Anthropic SDK — neither works on the edge runtime. The bound is the harness's
// per-stage maxSteps × maxTokens token ceiling, not an unbounded fan-out.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/events/ingest — the inbound event pipeline's front door.
 *
 * A normalized, provider-agnostic payload ({ familyRef, kind, subject, body, … })
 * is POSTed here by the inbound PROVIDER (Postmark inbound parse, a Gmail Pub/Sub
 * forwarder — the user's wiring step, see lib/pipeline/verify-secret.ts). The
 * request is authenticated by an HMAC of the raw body keyed by
 * INBOUND_WEBHOOK_SECRET (rule #4 — only an authenticated caller may inject a
 * billable, data-writing event); a missing secret or bad signature is 401 and the
 * handler does NOTHING (no DB read, no model call, no spend).
 *
 * On a verified call we run classify → draft → review and store a
 * drafted_for_approval action. This engine NEVER executes an external action — an
 * L1/L2 family's draft waits for a parent to approve via /api/actions/:id/approve.
 */

const inboundPayloadSchema = z.object({
  /** The Hale family this signal belongs to (the provider stores it). */
  familyRef: z.string().uuid(),
  /** Provider-side kind label (free-form), carried into the classifier context. */
  kind: z.string().min(1),
  subject: z.string().default(''),
  body: z.string().default(''),
  /** Any extra normalized fields the provider forwarded. */
  extra: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: Request) {
  // Read the RAW body first — the signature is computed over these exact bytes,
  // so we must not let JSON.parse re-serialize before verifying.
  const rawBody = await req.text();
  const signature = req.headers.get(INBOUND_SIGNATURE_HEADER);
  const verification = verifyInboundSignature(signature, rawBody);
  if (!verification.ok) {
    return NextResponse.json({ error: 'unauthorized', detail: verification.reason }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const payload = inboundPayloadSchema.safeParse(parsedJson);
  if (!payload.success) {
    return NextResponse.json(
      { error: 'invalid_payload', detail: payload.error.flatten() },
      { status: 400 },
    );
  }

  const database = db();

  // Family-scope the signal to a real family (rule #1). An unknown familyRef is
  // acknowledged but dropped — we never mint an event for a family we can't bind.
  const family = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, payload.data.familyRef))
    .limit(1);
  if (!family[0]) {
    return NextResponse.json({ status: 'unbound' }, { status: 200 });
  }

  try {
    const outcome = await ingestEvent(
      {
        familyId: family[0].id,
        source: payload.data.kind,
        subject: payload.data.subject,
        body: payload.data.body,
        extra: payload.data.extra,
      },
      database,
      pipelineClient(),
    );

    return NextResponse.json({ status: 'ingested', outcome }, { status: 200 });
  } finally {
    // Serverless flush: the pipeline emitted classify/draft/review traces — send
    // their buffered spans before the function returns (rule #8).
    await flushTelemetry();
  }
}
