'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { type DiscoverResult, defaultDiscoverDeps, discoverForFamily } from './discover';

/**
 * Server Action behind the "Find activities near you" button on /village.
 *
 * Auth is the spend gate (mirrors the coach route): when auth is unconfigured
 * (dev preview) we refuse and NEVER call the model — no spend, no guessing a
 * family. Signed-out / no resolved family also refuse before any model call.
 * On success the page is revalidated so the freshly-discovered candidates render.
 */

export type FindActivitiesResult =
  | DiscoverResult
  | { status: 'unauthenticated' }
  | { status: 'no_family' };

export async function findActivitiesAction(): Promise<FindActivitiesResult> {
  if (!authConfigured()) {
    return { status: 'unauthenticated' };
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return { status: 'unauthenticated' };
  }

  const database = defaultDb();
  const familyId = await resolveFamilyForUser(externalAuthId, database);
  if (!familyId) {
    return { status: 'no_family' };
  }

  const result = await discoverForFamily(familyId, database, defaultDiscoverDeps());
  revalidatePath('/village');
  return result;
}
