import { auth } from '~/auth';
import { db } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { type ConnectionSummary, listConnections } from './store';

/**
 * The current family's connector connections, for the Settings → Connectors UI.
 * Empty when signed out or when the user has no family yet (fail closed, rule #1).
 * Never returns tokens — only the summaries (provider/status/scopes/lastSyncAt).
 */
export async function loadFamilyConnectors(): Promise<ConnectionSummary[]> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) return [];
  const database = db();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) return [];
  return listConnections(database, familyId);
}
