import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { type FamilyBasicsView, toFamilyBasics } from '~/lib/dashboard/family-basics';
import { type FamilyMembersView, toFamilyMembersView } from '~/lib/dashboard/family-members';
import type { TrailView } from '~/lib/dashboard/mappers';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';

/**
 * PIPEDA / Law 25 right-to-access + portability: assembles everything Hale can
 * show a requesting parent about their family into one structured, downloadable
 * document, and writes the immutable `data_exported` audit row (rule #6).
 *
 * Rule #1 by CONSTRUCTION: the export composes the SAME parent-facing views the
 * app already renders — the family/children/parents facts a parent enters and
 * sees, and the ALREADY-REDACTED trail (loadTrailForFamily applies the identical
 * teen-content redaction the History page uses). It never reads a child's raw
 * subject/body, so a 13+ teen's content leaves as the placeholder, never raw text.
 * The requesting parent gets exactly what they can already see — nothing more.
 */

export interface FamilyExportDocument {
  /** ISO instant the export was assembled — the "copy taken at" stamp. */
  exportedAt: string;
  family: {
    id: string;
    displayName: string;
    location: FamilyBasicsView['location'];
    planTier: FamilyBasicsView['planTier'];
    intents: FamilyBasicsView['intents'];
  };
  children: FamilyBasicsView['children'];
  members: FamilyMembersView;
  /** The family's private village saves ("I'm interested" bookmarks) — user-
   * generated rows, so the right-to-access copy must include them. Title only:
   * the candidate title is the family-facing fact; ids stay internal. */
  savedActivities: { title: string; savedAt: string }[];
  /** The full, teen-redacted audit trail — the right-to-access record. */
  trail: TrailView[];
}

export interface AssembleFamilyExportDeps {
  /** The parent making the request (users.id) — the audit actor (rule #6). */
  actorUserId: string;
  /** Family-scoped, already-redacted trail loader. Injected so the redaction body
   * stays single-sourced (and swappable in tests). */
  loadTrail?: (database: Database, familyId: string) => Promise<TrailView[]>;
  now?: Date;
}

export async function assembleFamilyExport(
  database: Database,
  familyId: string,
  deps: AssembleFamilyExportDeps,
): Promise<FamilyExportDocument> {
  const loadTrail = deps.loadTrail ?? loadTrailForFamily;
  const now = deps.now ?? new Date();

  const [familyRow] = await database
    .select({
      displayName: schema.families.displayName,
      country: schema.families.country,
      province: schema.families.province,
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      planTier: schema.families.planTier,
      intents: schema.families.intents,
      foundingNumber: schema.families.foundingNumber,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  if (!familyRow) {
    throw new Error(`assembleFamilyExport: no family row for ${familyId}`);
  }

  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      lastName: schema.children.lastName,
      dateOfBirth: schema.children.dateOfBirth,
      gender: schema.children.gender,
      biologicalSex: schema.children.biologicalSex,
      interests: schema.children.interests,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId))
    .orderBy(schema.children.dateOfBirth);

  const memberRows = await database
    .select({
      name: schema.users.name,
      email: schema.users.email,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.familyMembers.familyId, familyId));

  const basics = toFamilyBasics(familyRow, childRows, now);
  const members = toFamilyMembersView(memberRows);
  const trail = await loadTrail(database, familyId);

  const saveRows = await database
    .select({
      title: schema.villageCandidates.title,
      savedAt: schema.villageSaves.createdAt,
    })
    .from(schema.villageSaves)
    .innerJoin(
      schema.villageCandidates,
      eq(schema.villageSaves.candidateId, schema.villageCandidates.id),
    )
    .where(eq(schema.villageSaves.familyId, familyId))
    .orderBy(schema.villageSaves.createdAt);
  const savedActivities = saveRows.map((row) => ({
    title: row.title,
    savedAt: row.savedAt.toISOString(),
  }));

  await database.insert(schema.auditLog).values({
    familyId,
    actor: deps.actorUserId,
    actionTaken: 'data_exported',
    targetTable: 'families',
    targetId: familyId,
  });

  return {
    exportedAt: now.toISOString(),
    family: {
      id: familyId,
      displayName: familyRow.displayName,
      location: basics.location,
      planTier: basics.planTier,
      intents: basics.intents,
    },
    children: basics.children,
    members,
    savedActivities,
    trail,
  };
}
