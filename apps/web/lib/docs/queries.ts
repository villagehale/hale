import { db as defaultDb } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { type DocumentView, listDocuments } from './documents.js';

/**
 * The family's Docs vault for a server render (the Companion Documents tab). The
 * SAME guarded degradation as the other companion reads: a credential-less preview
 * (no DATABASE_URL) or an unresolved family yields an empty list → the calm empty
 * state, never an error page. Redaction (rule #1 teen gate) is listDocuments' job;
 * the requesting user drives its parent-authored exemption, so it is read here.
 */
export async function loadFamilyDocuments(): Promise<DocumentView[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];
  const userId = await currentUserId(database);
  return listDocuments(database, familyId, userId);
}
