import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { ACTIVITY_HELD_TOPIC } from '~/lib/channel/activity/venue-pages';
import { privateAsidesSentTo } from '~/lib/channel/linq/private-aside-ledger';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { ExportTeenGate } from './export-memory';
import { accessExportRound2Enabled } from './export-round-2';

/**
 * The part of a right-to-access copy that is about the requesting adult alone: their 1:1
 * text thread with Hale, the language Hale writes to them in, each time that changed,
 * their consent records, the accounts they connected, and the events Hale mirrored from
 * their own Google Calendar, and the private texts Hale sent them from a shared group.
 *
 * Every read here is keyed on the requester, so nothing in this block can be about the
 * co-parent: the thread by its per-parent note key (note-key.ts), the settings by the
 * requester's own `users` row, and the language changes by the requester as actor. The
 * family-wide copy leaves `parent_language_changed` out for every parent
 * (NOT_IN_FAMILY_EXPORT), so this block is the only place those rows reach anyone.
 *
 * The thread keeps a turn the parent removed, stamped `removedAt`: Hale still holds its
 * words, and this copy goes only to the person who wrote or received them. The model
 * context a proactive turn carries (`messages.source`) is not part of it.
 *
 * Consent records are keyed on the requester as `user_id`, in this family or in none (a
 * consent given before the family existed). A record is one adult's yes or no in their
 * own words, so a co-parent's never reaches this copy. A teen-access request's evidence
 * describes the teen, so it leaves as null with `withheld: 'teen'` (rule #1); its type,
 * scope and dates stay. Lit, every type's evidence also runs through the teen gate, and
 * a type that names another adult or household (`village_intro`,
 * `caregiver_access_grant`) leaves evidence null with `withheld: 'another_adult'`. A
 * connection is the provider, the scopes and the dates; its tokens,
 * provider metadata and account key never leave. A calendar mirror is keyed on the
 * requester's own connection. Every connection has a user (integrations/store.ts is the
 * one writer), so this section covers them all.
 */
export interface RequesterOnlyExport {
  textThread: {
    role: 'user' | 'assistant';
    content: string;
    topic: string | null;
    sentAt: string;
    removedAt: string | null;
  }[];
  /** Null `proactiveLanguage` means Hale writes in the family's primary language. */
  language: {
    proactiveLanguage: string | null;
    languageStreakTag: string | null;
    languageStreakCount: number;
  };
  languageChanges: {
    changedAt: string;
    from: string | null;
    to: string | null;
    why: string | null;
  }[];
  consents: {
    type: string;
    scope: string | null;
    granted: boolean;
    grantedAt: string;
    revokedAt: string | null;
    expiresAt: string | null;
    policyVersion: string;
    evidence: Record<string, unknown> | null;
    ip: string | null;
    userAgent: string | null;
    withheld: 'teen' | 'another_adult' | null;
  }[];
  connections: {
    provider: string;
    scopes: string[];
    status: string;
    connectedAt: string;
    lastSyncAt: string | null;
  }[];
  calendarMirrors: {
    title: string;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    cancelledAt: string | null;
    withheld: 'teen' | null;
  }[];
  /** The private texts Hale sent this adult from a shared group (private-aside-ledger.ts). */
  privateAsides: {
    text: string;
    sentAt: string;
    withheld: 'teen' | null;
  }[];
}

const TEEN_EVIDENCE_CONSENT = 'teen_content_access';
/** Types whose evidence names another adult or another household. */
const OTHER_ADULT_EVIDENCE_CONSENTS = new Set(['village_intro', 'caregiver_access_grant']);

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function field(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : null;
}

export async function loadRequesterOnlyExport(
  database: Database,
  familyId: string,
  requesterUserId: string,
  gate: ExportTeenGate,
): Promise<RequesterOnlyExport> {
  const [user] = await database
    .select({
      proactiveLanguage: schema.users.proactiveLanguage,
      languageStreakTag: schema.users.languageStreakTag,
      languageStreakCount: schema.users.languageStreakCount,
    })
    .from(schema.users)
    .where(eq(schema.users.id, requesterUserId))
    .limit(1);
  if (!user) {
    throw new Error('loadRequesterOnlyExport: no user row for the requester');
  }

  const turns = await database
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      topic: schema.messages.topic,
      createdAt: schema.messages.createdAt,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.conversations.familyId, familyId),
        eq(schema.conversations.noteKey, channelSmsNoteKey(requesterUserId)),
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

  const changes = await database
    .select({
      before: schema.auditLog.before,
      after: schema.auditLog.after,
      occurredAt: schema.auditLog.occurredAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'parent_language_changed'),
        eq(schema.auditLog.actor, requesterUserId),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const consent = schema.consentRecords;
  const consentRows = await database
    .select({
      type: consent.consentType,
      scope: consent.consentScope,
      granted: consent.granted,
      grantedAt: consent.grantedAt,
      revokedAt: consent.revokedAt,
      expiresAt: consent.expiresAt,
      policyVersion: consent.policyVersion,
      evidence: consent.evidence,
      ip: consent.ip,
      userAgent: consent.userAgent,
    })
    .from(consent)
    .where(
      and(
        eq(consent.userId, requesterUserId),
        or(eq(consent.familyId, familyId), isNull(consent.familyId)),
      ),
    )
    .orderBy(asc(consent.grantedAt));

  const connectionRows = await database
    .select({
      provider: schema.integrations.provider,
      scopes: schema.integrations.scopes,
      status: schema.integrations.status,
      createdAt: schema.integrations.createdAt,
      lastSyncAt: schema.integrations.lastSyncAt,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        eq(schema.integrations.userId, requesterUserId),
      ),
    )
    .orderBy(asc(schema.integrations.createdAt));

  const events = schema.familyEvents;
  const mirrorRows = await database
    .select({
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      childId: events.childId,
      deletedAt: events.deletedAt,
    })
    .from(events)
    .innerJoin(schema.integrations, eq(schema.integrations.id, events.integrationId))
    .where(
      and(
        eq(events.familyId, familyId),
        isNotNull(events.googleEventId),
        eq(schema.integrations.userId, requesterUserId),
      ),
    )
    .orderBy(asc(events.startsAt));

  const asides = await privateAsidesSentTo(database, { familyId, userId: requesterUserId });

  const round2 = accessExportRound2Enabled();
  return {
    textThread: turns
      .filter((turn) => !round2 || turn.topic !== ACTIVITY_HELD_TOPIC)
      .map((turn) => ({
        role: turn.role,
        content: turn.content,
        topic: turn.topic,
        sentAt: turn.createdAt.toISOString(),
        removedAt: turn.deletedAt?.toISOString() ?? null,
      })),
    language: user,
    languageChanges: changes.map((row) => ({
      changedAt: row.occurredAt.toISOString(),
      from: field(row.before, 'language'),
      to: field(row.after, 'language'),
      why: field(row.after, 'why'),
    })),
    consents: consentRows.map((row) => {
      const teen =
        row.type === TEEN_EVIDENCE_CONSENT || (round2 && gate.isPrivate([], [row.evidence]));
      const otherAdult = round2 && OTHER_ADULT_EVIDENCE_CONSENTS.has(row.type);
      const withheld = teen ? ('teen' as const) : otherAdult ? ('another_adult' as const) : null;
      return {
        type: row.type,
        scope: row.scope,
        granted: row.granted,
        grantedAt: row.grantedAt.toISOString(),
        revokedAt: iso(row.revokedAt),
        expiresAt: iso(row.expiresAt),
        policyVersion: row.policyVersion,
        evidence: withheld ? null : row.evidence,
        ip: row.ip,
        userAgent: row.userAgent,
        withheld,
      };
    }),
    connections: connectionRows.map((row) => ({
      provider: row.provider,
      scopes: row.scopes,
      status: row.status,
      connectedAt: row.createdAt.toISOString(),
      lastSyncAt: iso(row.lastSyncAt),
    })),
    calendarMirrors: mirrorRows.map((row) => {
      const withheld = gate.isPrivate([row.childId], [row.title, row.location ?? ''])
        ? ('teen' as const)
        : null;
      return {
        title: withheld ? TEEN_REDACTED_PLACEHOLDER : row.title,
        startsAt: row.startsAt.toISOString(),
        endsAt: iso(row.endsAt),
        location: withheld ? null : row.location,
        cancelledAt: iso(row.deletedAt),
        withheld,
      };
    }),
    privateAsides: asides.map((aside) => {
      const withheld = gate.isPrivate([], [aside.text]) ? ('teen' as const) : null;
      return {
        text: withheld ? TEEN_REDACTED_PLACEHOLDER : aside.text,
        sentAt: aside.sentAt.toISOString(),
        withheld,
      };
    }),
  };
}
