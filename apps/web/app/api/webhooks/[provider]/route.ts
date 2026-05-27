import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getQueue } from '~/lib/queue';
import { verifyWebhookSignature } from '~/lib/webhooks/signatures';
import { resolveFamilyFromWebhook } from '~/lib/webhooks/resolve-family';

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

  const queue = await getQueue();
  await queue.send('events.ingested', {
    family_id: familyId,
    source: provider,
    payload,
    received_at: new Date().toISOString(),
  });

  return NextResponse.json({ status: 'queued' }, { status: 200 });
}
