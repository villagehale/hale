'use server';

import { auth } from '@clerk/nextjs/server';
import { type Database, schema } from '@hale/db';
import type { FamilyStage } from '@hale/types';
import { db as defaultDb } from '~/lib/db';
import { clerkConfigured } from '~/lib/auth-config';
import { resolveFamilyForClerkUser } from '~/lib/family';
import { type ChildInput, buildChildInserts, unionStages, validateChild } from './children';

/**
 * Persists the onboarding children for a family.
 *
 * The experience is for families across all of childhood, so this writes one
 * row per child with its date_of_birth — the only source of truth. No stage is
 * stored; the dashboard derives it live.
 *
 * Degradation (mirrors the dashboard read path and the approve route): when
 * Clerk is unconfigured (dev preview) OR there is no DATABASE_URL, the wizard
 * still validates and previews the derived stages, but NOTHING is written and
 * we return `preview` — never a fabricated family id, never a crash. A real
 * write only happens for a signed-in parent whose family resolves.
 */

export type OnboardingResult =
  | { status: 'saved'; familyId: string; childCount: number; stages: FamilyStage[] }
  | { status: 'preview'; reason: 'no_database' | 'no_auth' | 'no_family'; stages: FamilyStage[] }
  | { status: 'invalid'; index: number; error: string };

export async function saveOnboardingChildren(
  inputs: ReadonlyArray<ChildInput>,
  now: Date = new Date(),
): Promise<OnboardingResult> {
  const validated: { name: string; dateOfBirth: string; stage: FamilyStage }[] = [];
  for (const [index, input] of inputs.entries()) {
    const result = validateChild(input, now);
    if (!result.ok) {
      return { status: 'invalid', index, error: result.error };
    }
    validated.push(result.child);
  }

  const stages = unionStages(validated);

  if (!process.env.DATABASE_URL) {
    return { status: 'preview', reason: 'no_database', stages };
  }
  if (!clerkConfigured()) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const { userId } = await auth();
  if (!userId) {
    return { status: 'preview', reason: 'no_auth', stages };
  }

  const database = defaultDb();
  const familyId = await resolveFamilyForClerkUser(userId, database);
  if (!familyId) {
    return { status: 'preview', reason: 'no_family', stages };
  }

  await writeChildren(database, familyId, validated);
  return { status: 'saved', familyId, childCount: validated.length, stages };
}

async function writeChildren(
  database: Database,
  familyId: string,
  children: ReadonlyArray<{ name: string; dateOfBirth: string }>,
): Promise<void> {
  const rows = buildChildInserts(familyId, children).map((row) => ({
    familyId: row.familyId,
    name: row.name,
    dateOfBirth: row.dateOfBirth,
  }));
  await database.insert(schema.children).values(rows);
}
