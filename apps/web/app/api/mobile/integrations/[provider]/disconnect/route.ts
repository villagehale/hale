import { NextResponse } from 'next/server';
import { revokeFamilyConnector } from '~/lib/integrations/load';
import type { MobileIntegrationDisconnectResponse } from '../../../types';

export const runtime = 'nodejs';

/**
 * POST /api/mobile/integrations/[provider]/disconnect — the native counterpart to
 * the web disconnect route. Purges the connector's encrypted tokens and marks the
 * connection revoked (which stops sync), scoped to the caller's own
 * (family,user,provider) (rule #1). All DB access + the rule-#6 audit live behind
 * revokeFamilyConnector (this route stays DB-free per the tripwire). Bad provider →
 * 400; signed-out → 401; no family → 403; no matching connection → 404 (never a false
 * 'revoked'); no DB (dev preview) → 503.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await ctx.params;
  const result = await revokeFamilyConnector(provider);
  switch (result.status) {
    case 'revoked': {
      const body: MobileIntegrationDisconnectResponse = {
        status: 'revoked',
        provider: provider as MobileIntegrationDisconnectResponse['provider'],
      };
      return NextResponse.json(body);
    }
    case 'not_found':
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    case 'unsupported_provider':
      return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
    case 'preview':
      return NextResponse.json({ error: 'preview' }, { status: 503 });
    case 'no_family':
      return NextResponse.json({ error: 'no_family' }, { status: 403 });
    default:
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
}
