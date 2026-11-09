import { type NextRequest, NextResponse } from 'next/server';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { disconnectGoogle } from '~/lib/integrations/google-disconnect';
import { isConnectorProvider } from '~/lib/integrations/google-oauth';

export const runtime = 'nodejs';

/**
 * POST /api/integrations/[provider]/disconnect — through disconnectGoogle, the one door
 * (VIL-156): every Google connector of the caller ends, its push watches stop, and the
 * grant is revoked at Google. Family-scoped (rule #1): only the caller's own
 * connections are touched, and only when the named one holds keys.
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
  const result = await disconnectGoogle(database, {
    familyId,
    userId,
    via: 'settings',
    named: provider,
  });
  if (result.status === 'not_connected') {
    // Nothing was the caller's to disconnect (e.g. a co-parent's connection) —
    // never a false 'revoked'.
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({
    status: 'revoked',
    provider,
    providers: result.providers,
    google: result.google,
  });
}
