import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser, resolveUserIdForUser } from '~/lib/family';
import { isConnectorProvider } from './google-oauth';
import {
  type ConnectionSummary,
  listConnections,
  listUserConnections,
  revokeConnection,
} from './store';

/**
 * The connectors data access behind BOTH the web Settings page and the mobile
 * connector routes. Every DB touch lives here (the mobile routes stay DB-free per
 * the rule-#1 structural tripwire) — the routes only gate on auth and map the
 * status. Never returns tokens: only the summaries (provider/status/scopes/…).
 *
 * Degradation mirrors the notification-prefs lib: no DATABASE_URL / auth-unconfigured
 * is `preview`; a configured-but-signed-out caller is `unauthenticated`; a signed-in
 * parent with no family yet is `not_found` — never a crash, never a fabricated id.
 */

/**
 * The current family's connector connections, for the web Settings → Connectors UI.
 * Empty when signed out or when the user has no family yet (fail closed, rule #1).
 */
export async function loadFamilyConnectors(): Promise<ConnectionSummary[]> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return [];
  const database = defaultDb();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) return [];
  return listConnections(database, familyId);
}

export type ConnectorsStateResult =
  | { status: 'ready'; connections: ConnectionSummary[] }
  | { status: 'preview' }
  | { status: 'unauthenticated' };

/**
 * The signed-in parent's OWN connector connections for the mobile route — scoped to
 * (family,user) so the native list matches the disconnect key: a co-parent never sees
 * (and so can never no-op-disconnect) the other parent's connection, and each provider
 * carries at most one row so the status is unambiguous. A signed-in parent with no
 * family resolves to an empty list (all not-connected) rather than an error — the
 * connectors surface reads the same whether they've onboarded or not.
 */
export async function loadConnectorsState(): Promise<ConnectorsStateResult> {
  if (!process.env.DATABASE_URL || !authConfigured()) return { status: 'preview' };
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return { status: 'unauthenticated' };

  const database = defaultDb();
  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  const connections =
    familyId && userId ? await listUserConnections(database, familyId, userId) : [];
  return { status: 'ready', connections };
}

export type RevokeConnectorResult =
  | { status: 'revoked' }
  | { status: 'not_found' }
  | { status: 'preview' }
  | { status: 'unauthenticated' }
  | { status: 'unsupported_provider' }
  | { status: 'no_family' };

/**
 * Revoke one connector for the signed-in family (purges tokens + writes the rule-#6
 * audit row, both inside revokeConnection). Scoped to the caller's own
 * (family,user,provider) (rule #1). A bad provider slug is rejected here so the route
 * carries no provider knowledge. When no row matched (nothing was the caller's to
 * disconnect) the result is 'not_found' — never a false 'revoked'.
 */
export async function revokeFamilyConnector(provider: string): Promise<RevokeConnectorResult> {
  if (!process.env.DATABASE_URL || !authConfigured()) return { status: 'preview' };
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return { status: 'unauthenticated' };
  // Auth precedes input validation (sibling-route ordering): an unauthenticated
  // caller learns nothing — not even that a provider slug is unsupported.
  if (!isConnectorProvider(provider)) return { status: 'unsupported_provider' };

  const database = defaultDb();
  const [familyId, userId] = await Promise.all([
    resolveFamilyForUser(externalAuthId, database),
    resolveUserIdForUser(externalAuthId, database),
  ]);
  if (!familyId || !userId) return { status: 'no_family' };

  const revokedCount = await revokeConnection(database, familyId, userId, provider);
  return revokedCount > 0 ? { status: 'revoked' } : { status: 'not_found' };
}
