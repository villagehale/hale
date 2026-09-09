import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { type FamilyBasicsView, toFamilyBasics } from '~/lib/dashboard/family-basics';
import { type FamilyMembersView, toFamilyMembersView } from '~/lib/dashboard/family-members';
import type { TrailView } from '~/lib/dashboard/mappers';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { MCP_SCOPES, type McpScope, isMcpScope } from '~/lib/mcp/contracts';

/**
 * PIPEDA / Law 25 right-to-access + portability: assembles everything Hale can
 * show a requesting parent about their family into one structured, downloadable
 * document, and writes the immutable `data_exported` audit row (rule #6).
 *
 * Rule #1 by CONSTRUCTION: the export composes the SAME parent-facing views the
 * app already renders — the family/children/parents facts a parent enters and
 * sees, and the ALREADY-REDACTED trail. It never reads a child's raw subject/body,
 * so a 13+ teen's content leaves as the placeholder, never raw text.
 *
 * VIL-147: the export calls loadTrailForFamily WITHOUT an unlock set, so it renders
 * at the MOST-PRIVATE level even for a parent holding an active teen access grant.
 * That is deliberate and is asserted by teen-access-outbound.test.ts: a grant is a
 * time-limited disclosure on the authenticated in-app surface, while an export is a
 * durable file that outlives the window and leaves the app entirely.
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
  /**
   * This parent's third-party assistant connection history. Deliberately omits
   * grant/client/consent ids and every token-derived value.
   */
  assistantConnections: {
    clientName: string;
    scopes: McpScope[];
    status: 'active' | 'expired' | 'revoked';
    connectedAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    revokedAt: string | null;
  }[];
  /**
   * VIL-338 · what Hale holds about a registration morning this family is preparing
   * for. METADATA ONLY, and the omissions are the point: the course id inside the
   * pasted URL names the exact class one of this family's children is being registered
   * for, so only the HOST leaves — the parent already has the link, because they sent
   * it. No price, no child, no message id. Present-and-empty for a family with none: a
   * copy that simply omits a section leaves a parent unable to tell "Hale holds none of
   * this" from "Hale did not look".
   */
  registrationPreparation: {
    municipality: string;
    cycleLabel: string;
    courseHost: string | null;
    courseOpensAt: string | null;
    /** What the parent TOLD Hale about their portal setup. Null is unanswered. */
    readinessReady: boolean | null;
    /** When this ROW last changed — not when the link was pasted, which is a dated line
     * in the trail below. Later reads refresh the anchor on the same row. */
    updatedAt: string;
  }[];
  /**
   * VIL-337 · the class pages this family asked Hale to re-read for a spot. A watch is
   * a standing instruction the family gave, so a right-to-access copy without it would
   * omit the one thing Hale is doing on their behalf every ten minutes. Host and state
   * only, on the same reasoning as the block above; the label the parent chose is
   * already a trail line.
   */
  watchedSpots: {
    host: string | null;
    state: string;
    createdAt: string;
    releasedAt: string | null;
    releasedReason: string | null;
  }[];
  /** The full, teen-redacted audit trail — the right-to-access record. */
  trail: TrailView[];
}

/** The host of a stored, already-sanitized portal URL. Null rather than a throw: a
 * right-to-access export must not fail on one odd row. */
function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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

  const assistantRows = await database
    .select({
      clientName: schema.mcpOauthClients.clientName,
      scopes: schema.mcpGrants.scopes,
      createdAt: schema.mcpGrants.createdAt,
      lastUsedAt: schema.mcpGrants.lastUsedAt,
      expiresAt: schema.mcpGrants.expiresAt,
      revokedAt: schema.mcpGrants.revokedAt,
    })
    .from(schema.mcpGrants)
    .innerJoin(
      schema.mcpOauthClients,
      eq(schema.mcpGrants.clientId, schema.mcpOauthClients.clientId),
    )
    .where(
      and(eq(schema.mcpGrants.familyId, familyId), eq(schema.mcpGrants.userId, deps.actorUserId)),
    )
    .orderBy(schema.mcpGrants.createdAt);
  const assistantConnections = assistantRows.flatMap((row) => {
    if (!Array.isArray(row.scopes) || row.scopes.some((scope) => !isMcpScope(String(scope)))) {
      return [];
    }
    const status: 'active' | 'expired' | 'revoked' = row.revokedAt
      ? 'revoked'
      : row.expiresAt <= now
        ? 'expired'
        : 'active';
    return [
      {
        clientName: row.clientName,
        scopes: MCP_SCOPES.filter((scope) => row.scopes.includes(scope)),
        status,
        connectedAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      },
    ];
  });

  const preparationRows = await database
    .select({
      municipality: schema.registrationWindows.municipality,
      cycleLabel: schema.registrationWindows.cycleLabel,
      courseUrl: schema.registrationSequences.courseUrl,
      courseOpensAt: schema.registrationSequences.courseOpensAt,
      readinessReady: schema.registrationSequences.readinessReady,
      updatedAt: schema.registrationSequences.updatedAt,
    })
    .from(schema.registrationSequences)
    .innerJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .where(eq(schema.registrationSequences.familyId, familyId))
    .orderBy(schema.registrationSequences.createdAt);
  // A claimed window nobody has pasted a link for or answered about holds nothing this
  // block is about: the shortlist itself is already a trail line and an approvals row.
  const registrationPreparation = preparationRows
    .filter((row) => row.courseUrl !== null || row.readinessReady !== null)
    .map((row) => ({
      municipality: row.municipality,
      cycleLabel: row.cycleLabel,
      courseHost: hostOf(row.courseUrl),
      courseOpensAt: row.courseOpensAt?.toISOString() ?? null,
      readinessReady: row.readinessReady,
      updatedAt: row.updatedAt.toISOString(),
    }));

  const watchRows = await database
    .select({
      sourceUrl: schema.watchedSpots.sourceUrl,
      lastState: schema.watchedSpots.lastState,
      createdAt: schema.watchedSpots.createdAt,
      releasedAt: schema.watchedSpots.releasedAt,
      releasedReason: schema.watchedSpots.releasedReason,
    })
    .from(schema.watchedSpots)
    .where(eq(schema.watchedSpots.familyId, familyId))
    .orderBy(schema.watchedSpots.createdAt);
  const watchedSpots = watchRows.map((row) => ({
    host: hostOf(row.sourceUrl),
    state: row.lastState,
    createdAt: row.createdAt.toISOString(),
    releasedAt: row.releasedAt?.toISOString() ?? null,
    releasedReason: row.releasedReason,
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
    assistantConnections,
    registrationPreparation,
    watchedSpots,
    trail,
  };
}
