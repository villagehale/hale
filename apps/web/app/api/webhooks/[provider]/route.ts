import { NextResponse, type NextRequest, after } from 'next/server';
import { getQueue } from '~/lib/queue';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { kickDrain } from '~/lib/cron/kick-drain';
import { getAdapter } from '~/lib/webhooks/registry';
import { resolveFamilyFromWebhook } from '~/lib/webhooks/resolve-family';
import { verifyStripeBillingSignature } from '~/lib/webhooks/stripe-billing';

interface RouteContext {
  params: Promise<{ provider: string }>;
}

export async function POST(req: NextRequest, context: RouteContext) {
  const { provider: rawProvider } = await context.params;
  const adapter = getAdapter(rawProvider);
  if (!adapter) {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 404 });
  }
  const provider = adapter.provider;

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

  // ── Signal providers dispatch through the registry ────────────────────────
  // The adapter's verify() is the structural gate: a not-yet-live leg returns
  // `not_configured` → 501 (known-but-not-live, mirroring stripe-billing) and
  // the request NEVER reaches ingestion. A configured-but-bad signature → 401.
  // Only `verified` continues to extract → ingest.
  const verification = adapter.verify(signature, rawBody);
  if (verification.status === 'not_configured') {
    return NextResponse.json(
      { error: 'provider_not_live', detail: verification.reason },
      { status: 501 },
    );
  }
  if (verification.status === 'invalid') {
    return NextResponse.json(
      { error: 'invalid_signature', detail: verification.reason },
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

  const event = adapter.toIngestedEvent(familyId, payload as Record<string, unknown>);

  const queue = await getQueue();
  await queue.send('events.ingested', event, { expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });

  // Kick the drain so an inbound signal flows through the pipeline now rather
  // than waiting up to 60s for the next cron tick (the cron is the safety net).
  const origin = process.env.APP_URL ?? new URL(req.url).origin;
  after(() => kickDrain(origin));

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}
