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
  /**
   * Google given names Hale is holding and has not confirmed. Separate from
   * {@link FamilyExportDocument.members}, whose `name` is the confirmed call name
   * only — an unconfirmed candidate must not read as what Hale calls this parent.
   * Primary and co-parent only.
   */
  unconfirmedCallNames: { role: 'primary_parent' | 'co_parent'; givenName: string }[];
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
  /**
   * The places this family holds, read out of a provider's own confirmation email. A
   * booking is a fact about the family that Hale HOLDS and acts on a week later - it is
   * what makes the "how did it go?" ask happen - so a right-to-access copy without it
   * would omit something Hale does on their behalf. The host and not the address, on the
   * same reasoning as the block above; no confirmation number, no amount, no child,
   * because the table has no column for any of them.
   */
  activityBookings: {
    title: string;
    firstSessionAt: string;
    providerHost: string;
    addedToCalendar: boolean;
    /** Set when the provider called the class off, so the copy does not read as a place
     * the family still holds. */
    cancelledAt: string | null;
  }[];
  /**
   * VIL-353 · the evening check-in: how often this household is asked how the day went,
   * and what THIS parent wrote back.
   *
   * SCOPED TO THE REQUESTER, unlike every other block here, because a day note is a
   * parent's own unedited sentence about their household — the one thing in this product
   * that is deliberately kept off every shared surface (rule #1, checkin/notes.ts). The
   * export is a durable file that leaves the app, so the strictest reading is the only
   * one: a parent gets their own words, and never their co-parent's.
   *
   * THE RAW WORDS ARE INCLUDED, and they belong here. They are the parent's own, Hale
   * holds them for thirty days without showing them to anyone, and a right-to-access copy
   * that listed the dates but not the sentences would be a copy of the index rather than
   * of the data.
   */
  eveningCheckIn: {
    /** Null where the household has never been asked, which is not the same as 'daily'. */
    cadence: 'daily' | 'weekly' | 'off' | null;
    lastAskedAt: string | null;
    lastAnsweredAt: string | null;
    notes: { notedOn: string; note: string; expiresAt: string }[];
  };
  /**
   * What this household said about the activities Hale placed for it — a verdict and up
   * to three tags per public venue.
   *
   * FAMILY-SCOPED, NOT REQUESTER-SCOPED, unlike the day notes above, and the reason is in
   * the data rather than in a policy: a verdict is a household's position on a PUBLIC
   * venue, with no free text, no child name, and no sensitive or teen placement behind it
   * (the capture pass refuses all three before a model ever reads the reply). There is
   * nothing in the row a co-parent may not see.
   *
   * THE PARENT'S SENTENCE IS NOT HERE, because it is stored nowhere. It survives only on
   * the inbound message row it arrived on. "Private" is true; "recoverable" is true only
   * through that row.
   */
  activityReviews: {
    subjectSource: 'place' | 'civic_venue';
    subjectRef: string;
    areaKey: string;
    childAgeBand: string | null;
    verdict: string;
    tags: string[];
    createdAt: string;
  }[];
  /**
   * The trips Hale read out of THIS REQUESTER'S mailbox — the destination, the dates, why
   * Hale thought the children were on it, and how it ended.
   *
   * REQUESTER-SCOPED, like the day notes and the assistant grants and unlike everything
   * else in this document, and the scope is the whole of the decision. Every other fact
   * about a trip says it belongs to one parent: it is detected from ONE parent's mailbox,
   * texted to THAT parent's phone, and cascades on THAT user's row. The export is the one
   * durable file that leaves the app, so it was the single surface on which parent A's
   * booking could reach parent B — and Hale supports separated co-parents, which makes a
   * solo travel date exactly the disclosure the privacy moat exists to prevent.
   *
   * Present-and-empty rather than omitted, the rule the whole document keeps: a copy that
   * omits a section leaves a parent unable to tell "Hale holds none of this" from "Hale
   * did not look".
   *
   * WHAT A CO-PARENT STILL SEES, stated because it is the residue rather than a bug: the
   * trail is family-scoped, so they read "Hale noticed a trip coming up" with a date and
   * no destination. That is the existing posture for every connector verb, and narrowing
   * it is a change to the trail rather than to this block.
   */
  trips: {
    destinationCity: string;
    destinationRegion: string | null;
    startsOn: string;
    endsOn: string;
    childEvidence: string;
    closedAt: string | null;
    closedReason: string | null;
  }[];
  /**
   * Instinct-style daily and weekly memory rollups. Counts and closed labels
   * only — the prose line and any message text are not in this copy, because
   * the rollup is a derived index of rows already represented elsewhere.
   */
  memoryDigests: {
    grain: 'day' | 'week';
    periodStart: string;
    timezone: string;
    generatedAt: string;
    inbound: number;
    outbound: number;
    openWorkstreamCount: number;
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
      googleGivenName: schema.users.googleGivenName,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.familyMembers.familyId, familyId));

  const basics = toFamilyBasics(familyRow, childRows, now);
  const members = toFamilyMembersView(memberRows);
  const unconfirmedCallNames = memberRows.flatMap((row) => {
    if (row.role !== 'primary_parent' && row.role !== 'co_parent') return [];
    const givenName = row.googleGivenName?.trim();
    if (!givenName) return [];
    return [{ role: row.role, givenName }];
  });
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

  const bookingRows = await database
    .select({
      title: schema.activityBookings.title,
      firstSessionAt: schema.activityBookings.firstSessionAt,
      providerHost: schema.activityBookings.providerHost,
      eventId: schema.activityBookings.eventId,
      cancelledAt: schema.activityBookings.cancelledAt,
    })
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, familyId))
    .orderBy(schema.activityBookings.firstSessionAt);
  const activityBookings = bookingRows.map((row) => ({
    title: row.title,
    firstSessionAt: row.firstSessionAt.toISOString(),
    providerHost: row.providerHost,
    addedToCalendar: row.eventId !== null,
    // The provider called it off. Without this a right-to-access copy reads as a place the
    // family still holds — a fact about them that stopped being true, and the one Hale
    // itself stopped acting on when it closed the row.
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  }));

  const [checkInPrefs] = await database
    .select({
      cadence: schema.familyCheckInPrefs.cadence,
      lastAskedAt: schema.familyCheckInPrefs.lastAskedAt,
      lastAnsweredAt: schema.familyCheckInPrefs.lastAnsweredAt,
    })
    .from(schema.familyCheckInPrefs)
    .where(eq(schema.familyCheckInPrefs.familyId, familyId))
    .limit(1);

  const noteRows = await database
    .select({
      notedOn: schema.familyCheckInNotes.notedOn,
      note: schema.familyCheckInNotes.note,
      expiresAt: schema.familyCheckInNotes.expiresAt,
    })
    .from(schema.familyCheckInNotes)
    .where(
      and(
        eq(schema.familyCheckInNotes.familyId, familyId),
        eq(schema.familyCheckInNotes.parentUserId, deps.actorUserId),
      ),
    )
    .orderBy(schema.familyCheckInNotes.notedOn);
  const eveningCheckIn = {
    cadence: checkInPrefs?.cadence ?? null,
    lastAskedAt: checkInPrefs?.lastAskedAt?.toISOString() ?? null,
    lastAnsweredAt: checkInPrefs?.lastAnsweredAt?.toISOString() ?? null,
    notes: noteRows.map((row) => ({
      notedOn: row.notedOn,
      note: row.note,
      expiresAt: row.expiresAt.toISOString(),
    })),
  };

  const reviewRows = await database
    .select({
      subjectSource: schema.activityReviews.subjectSource,
      subjectRef: schema.activityReviews.subjectRef,
      areaKey: schema.activityReviews.areaKey,
      childAgeBand: schema.activityReviews.childAgeBand,
      verdict: schema.activityReviews.verdict,
      tags: schema.activityReviews.tags,
      createdAt: schema.activityReviews.createdAt,
    })
    .from(schema.activityReviews)
    .where(eq(schema.activityReviews.familyId, familyId))
    .orderBy(schema.activityReviews.createdAt);
  const activityReviews = reviewRows.map((row) => ({
    subjectSource: row.subjectSource,
    subjectRef: row.subjectRef,
    areaKey: row.areaKey,
    childAgeBand: row.childAgeBand,
    verdict: row.verdict,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
  }));

  const tripRows = await database
    .select({
      destinationCity: schema.familyTrips.destinationCity,
      destinationRegion: schema.familyTrips.destinationRegion,
      startsOn: schema.familyTrips.startsOn,
      endsOn: schema.familyTrips.endsOn,
      childEvidence: schema.familyTrips.childEvidence,
      closedAt: schema.familyTrips.closedAt,
      closedReason: schema.familyTrips.closedReason,
    })
    .from(schema.familyTrips)
    .where(
      and(
        eq(schema.familyTrips.familyId, familyId),
        // THE FILTER IS THE FEATURE. Without it this block is the one place a co-parent
        // reads where the other parent went and when — see the doc comment above.
        eq(schema.familyTrips.parentUserId, deps.actorUserId),
      ),
    )
    .orderBy(schema.familyTrips.startsOn);
  const trips = tripRows.map((row) => ({
    destinationCity: row.destinationCity,
    destinationRegion: row.destinationRegion,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    childEvidence: row.childEvidence,
    closedAt: row.closedAt?.toISOString() ?? null,
    closedReason: row.closedReason,
  }));

  const digestRows = await database
    .select({
      grain: schema.familyMemoryDigests.grain,
      periodStart: schema.familyMemoryDigests.periodStart,
      timezone: schema.familyMemoryDigests.timezone,
      generatedAt: schema.familyMemoryDigests.generatedAt,
      summary: schema.familyMemoryDigests.summary,
    })
    .from(schema.familyMemoryDigests)
    .where(eq(schema.familyMemoryDigests.familyId, familyId))
    .orderBy(schema.familyMemoryDigests.periodStart);
  const memoryDigests = digestRows.flatMap((row) => {
    if (row.grain !== 'day' && row.grain !== 'week') return [];
    const summary = row.summary as {
      inbound?: unknown;
      outbound?: unknown;
      openWorkstreams?: unknown;
    };
    const open = Array.isArray(summary.openWorkstreams) ? summary.openWorkstreams.length : 0;
    return [
      {
        grain: row.grain,
        periodStart: row.periodStart,
        timezone: row.timezone,
        generatedAt: row.generatedAt.toISOString(),
        inbound: typeof summary.inbound === 'number' ? summary.inbound : 0,
        outbound: typeof summary.outbound === 'number' ? summary.outbound : 0,
        openWorkstreamCount: open,
      },
    ];
  });

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
    unconfirmedCallNames,
    savedActivities,
    assistantConnections,
    registrationPreparation,
    watchedSpots,
    activityBookings,
    eveningCheckIn,
    activityReviews,
    trips,
    memoryDigests,
    trail,
  };
}
