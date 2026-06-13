import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import type { IngestedEventPayload } from '@hearth/tools-contracts';
import { getQueue } from '~/lib/queue';
import { verifyWebhookSignature } from '~/lib/webhooks/signatures';
import { resolveFamilyFromWebhook } from '~/lib/webhooks/resolve-family';
import { verifyStripeBillingSignature } from '~/lib/webhooks/stripe-billing';

const SUPPORTED_PROVIDERS = ['gmail', 'gcal', 'outlook', 'stripe', 'twilio'] as const;
const providerSchema = z.enum(SUPPORTED_PROVIDERS);

interface RouteContext {
  params: Promise<{ provider: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  const { provider: rawProvider } = await context.params;
  const providerParse = providerSchema.safeParse(rawProvider);
  if (!providerParse.success) {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 404 });
  }
  const provider = providerParse.data;

  const rawBody = await req.text();
  const signature = req.headers.get('x-webhook-signature') ?? req.headers.get('stripe-signature');

  // ── B18 Stripe billing contract ──────────────────────────────────────────
  // Stripe billing events are a DIFFERENT contract from agent-pipeline signals:
  // they transition plan_tier, they do NOT flow to events.ingested. Stripe LIVE
  // is blocked (no keys), so the verify gate is a named TODO that returns 501
  // until STRIPE_WEBHOOK_SECRET exists. We NEVER process an unverified billing
  // event — a forged event could grant a paid tier for free. The plan_tier
  // transition (planTierFromStripeEvent → families.plan_tier) lands behind this
  // gate when keys arrive; see lib/webhooks/stripe-billing.ts for the mapping.
  if (provider === 'stripe') {
    const verification = verifyStripeBillingSignature(signature, rawBody);
    if (verification.status === 'not_configured') {
      return NextResponse.json(
        { error: 'stripe_billing_not_live', detail: verification.reason },
        { status: 501 },
      );
    }
    if (verification.status === 'invalid') {
      return NextResponse.json(
        { error: 'invalid_signature', detail: verification.reason },
        { status: 401 },
      );
    }
    // status === 'verified' — live plan_tier application wires here at go-live.
    return NextResponse.json({ status: 'verified' }, { status: 200 });
  }

  try {
    await verifyWebhookSignature(provider, signature, rawBody);
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_signature', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const familyId = await resolveFamilyFromWebhook(provider, payload);
  if (!familyId) {
    // Acknowledge but drop — we don't have a family bound to this signal.
    return NextResponse.json({ status: 'unbound' }, { status: 200 });
  }

  const event: IngestedEventPayload = {
    family_id: familyId,
    source: provider,
    payload: payload as IngestedEventPayload['payload'],
    received_at: new Date().toISOString(),
  };

  const queue = await getQueue();
  await queue.send('events.ingested', event);

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}
