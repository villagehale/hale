import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { isConnectorProvider } from '~/lib/integrations/google-oauth';
import { revokeConnection } from '~/lib/integrations/store';

export const runtime = 'nodejs';

/**
 * POST /api/integrations/[provider]/disconnect — purge the connector's encrypted
 * tokens and mark the connection revoked (which also stops sync). Family-scoped
 * (rule #1): only the caller's own connection is touched.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  if (!authConfigured()) {
    return NextResponse.json({ error: 'auth_required' }, { status: 501 });
  }
  const { provider } = await ctx.params;
  if (!isConnectorProvider(provider)) {
    return NextResponse.json({ error: 'unsupported_provider' }, { status: 400 });
  }
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const database = db();
  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !userId) {
    return NextResponse.json({ error: 'no_family' }, { status: 403 });
  }
  await revokeConnection(database, familyId, userId, provider);
  return NextResponse.json({ status: 'revoked', provider });
}
