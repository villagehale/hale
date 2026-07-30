import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { and, count, eq } from 'drizzle-orm';
import type { ResendTransport } from '~/lib/channel/resend-transport';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { type ChildNameLevel, loadLoopPrefsView } from '~/lib/loop/prefs';
import { eventDescriptor, isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild, ReminderEventView } from '~/lib/loop/templates/reminder/payload';
import { mintIcsToken } from './ics-feed.js';
import {
  type IcsInviteEvent,
  type IcsMethod,
  generateEventCancel,
  generateEventInvite,
  generateEventPublish,
} from './ics.js';

/**
 * VIL-249 · M13 — the per-event calendar invite: add-to-calendar with zero OAuth. An
 * event leaves Hale two ways, both landing on the SAME UID so a client updates in place
 * rather than duplicating: attached to an email as an iTIP REQUEST/CANCEL, or behind an
 * unguessable link an SMS can carry.
 *
 * TOKEN (no new schema): a per-event token is `<familyEventId>.<sig>` where sig is
 * HMAC-SHA256 of the event id KEYED BY the family's own `families.ics_share_token` — the
 * high-entropy per-family secret the subscription feed already mints. Three properties
 * fall out for free: the link is unguessable without the family secret; the HMAC is
 * one-way, so a forwarded event link never reveals the family's whole-calendar feed
 * token; and `revokeIcsToken` (nulling that column) kills every per-event link at once,
 * so revocation needs no new primitive and no new column. Soft-deleting the event is the
 * per-event revoke.
 *
 * SEQUENCE (no new schema): family_events carries no `updated_at`, so the revision is
 * derived from the event's own immutable audit trail — the COUNT of audit_log rows
 * targeting it. Rule #6 makes that append-only and monotonic by construction: every
 * calendar_placed / calendar_moved / calendar_cancelled / reverted write leaves exactly
 * one row, so the count rises exactly when the event changes and never falls. A CANCEL
 * is issued one above the count so it always supersedes the last REQUEST, whatever the
 * ordering of its own audit write.
 *
 * PRIVACY (rule #1): an invite is an OUTBOUND surface, so its SUMMARY/LOCATION/
 * DESCRIPTION get the same treatment as the channel carrying it — `isPrivateEvent` +
 * `eventDescriptor`, shared verbatim with the reminder templates: a 13+ child's event
 * and any `sensitive` event genericize to a bare descriptor with no location and no
 * description, and a non-teen child is named only down to the recipient's own dial.
 */

/** The from-identity the invite is sent under; the ORGANIZER must match it or clients
 * reject the iTIP object. Mirrors DEFAULT_FROM in lib/cron/email.ts. */
const INVITE_FROM = 'aloha@villagehale.com';
const ORGANIZER_NAME = 'Hale';
const ATTACHMENT_FILENAME = 'invite.ics';
const TOKEN_SEPARATOR = '.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One family event with everything the invite needs: the fields it renders, the teen
 * gate's DOB, and the family secret the token is keyed by. */
export interface InviteEventRow {
  id: string;
  familyId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  sensitive: boolean;
  deletedAt: Date | null;
  childId: string | null;
  childName: string | null;
  childDob: string | null;
  childGender: string | null;
  icsShareToken: string | null;
}

// ── Token ────────────────────────────────────────────────────────────────────

function signEventId(familyEventId: string, icsShareToken: string): string {
  return createHmac('sha256', icsShareToken).update(familyEventId).digest('base64url');
}

/** The per-event token for an event under a family holding `icsShareToken`. */
export function eventInviteToken(familyEventId: string, icsShareToken: string): string {
  return `${familyEventId}${TOKEN_SEPARATOR}${signEventId(familyEventId, icsShareToken)}`;
}

/** The absolute link a channel carries. App domain only — the marketing domain
 * 308-redirects and would break a calendar client following it. */
export function eventInviteUrl(token: string): string {
  return `${appBaseUrl()}/api/ics/event/${token}`;
}

/**
 * Mints (idempotently) the family's feed token and returns the absolute per-event link
 * — the SMS leg's whole surface. The first mint writes its own audit row inside
 * `mintIcsToken` (rule #6); a family that already has a token gets no new write.
 */
export async function mintEventInviteLink(
  database: Database,
  familyId: string,
  familyEventId: string,
): Promise<string> {
  const { token } = await mintIcsToken(database, familyId);
  return eventInviteUrl(eventInviteToken(familyEventId, token));
}

function parseInviteToken(token: string): { familyEventId: string; signature: string } | null {
  const separator = token.indexOf(TOKEN_SEPARATOR);
  if (separator <= 0) return null;
  const familyEventId = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  // The id reaches a uuid column — a malformed one must 404, not raise a Postgres error.
  if (!UUID_RE.test(familyEventId) || signature.length === 0) return null;
  return { familyEventId, signature };
}

/** Constant-time signature check. Fails closed on a revoked (null) family token. */
function signatureMatches(
  familyEventId: string,
  icsShareToken: string | null,
  signature: string,
): boolean {
  if (!icsShareToken) return false;
  const expected = Buffer.from(signEventId(familyEventId, icsShareToken), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The event behind an id, with its family's feed token and the child DOB the teen gate
 * needs. Soft-deleted rows are INCLUDED — a CANCEL is precisely the invite for an event
 * that has just been deleted; callers filter on `deletedAt` per method.
 */
async function loadInviteEventRow(
  database: Database,
  familyEventId: string,
): Promise<InviteEventRow | null> {
  const rows = await database
    .select({
      id: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      sensitive: schema.familyEvents.sensitive,
      deletedAt: schema.familyEvents.deletedAt,
      childId: schema.familyEvents.childId,
      childName: schema.children.name,
      childDob: schema.children.dateOfBirth,
      childGender: schema.children.gender,
      icsShareToken: schema.families.icsShareToken,
    })
    .from(schema.familyEvents)
    .leftJoin(schema.children, eq(schema.familyEvents.childId, schema.children.id))
    .innerJoin(schema.families, eq(schema.familyEvents.familyId, schema.families.id))
    .where(eq(schema.familyEvents.id, familyEventId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The event's RFC 5545 SEQUENCE: how many immutable audit rows it has accumulated
 * (rule #6 — one per change, never removed). A CANCEL takes the next value up so it
 * supersedes the last REQUEST regardless of when its own audit row lands.
 */
export async function icsSequence(
  database: Database,
  familyId: string,
  familyEventId: string,
  method: IcsMethod,
): Promise<number> {
  const rows = await database
    .select({ value: count() })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'family_events'),
        eq(schema.auditLog.targetId, familyEventId),
      ),
    );
  const changes = rows[0]?.value ?? 0;
  return method === 'CANCEL' ? changes + 1 : changes;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * The stored row rendered into the serializer's input at the recipient's privacy level.
 * Private (teen or sensitive) events keep only their times: a generic SUMMARY, no
 * LOCATION, and no DESCRIPTION — the caller's note is dropped wholesale rather than
 * trusted, since it was composed outside this gate.
 */
export function toInviteEvent(
  row: InviteEventRow,
  options: { level: ChildNameLevel; note: string | null; sequence: number },
  now: Date,
): IcsInviteEvent {
  const children: ReminderChild[] =
    row.childId && row.childName && row.childDob
      ? [
          {
            id: row.childId,
            name: row.childName,
            dateOfBirth: row.childDob,
            gender: row.childGender,
          },
        ]
      : [];
  const view: ReminderEventView = {
    eventRef: row.id,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    childId: row.childId,
    sensitive: row.sensitive,
  };
  const isPrivate = isPrivateEvent(view, children, now);

  return {
    id: row.id,
    summary: eventDescriptor(view, children, options.level, now),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    location: isPrivate ? null : row.location,
    description: isPrivate ? null : options.note,
    sequence: options.sequence,
  };
}

// ── The tokened single-event read (the SMS leg's destination) ─────────────────

/**
 * Resolves a per-event token to that one event's calendar file, or null for a token that
 * is malformed, forged, revoked (family feed token nulled), or whose event is gone. A
 * link is addressed to NOBODY, so it serves a PUBLISH rather than an invite, and it
 * renders at the most-private name level — the same floor an outbound third-party
 * disclosure gets, since whoever holds the link is not an authenticated parent.
 */
export async function loadEventInvite(
  database: Database,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  const parsed = parseInviteToken(token);
  if (!parsed) return null;

  const row = await loadInviteEventRow(database, parsed.familyEventId);
  if (!row || row.deletedAt !== null) return null;
  if (!signatureMatches(parsed.familyEventId, row.icsShareToken, parsed.signature)) return null;

  const sequence = await icsSequence(database, row.familyId, row.id, 'REQUEST');
  const invite = toInviteEvent(row, { level: 'generic', note: null, sequence }, now);
  return generateEventPublish(invite, {
    organizerEmail: INVITE_FROM,
    organizerName: ORGANIZER_NAME,
    now,
  });
}

// ── The email leg ────────────────────────────────────────────────────────────

export interface SendEventInviteInput {
  familyId: string;
  familyEventId: string;
  /** The recipient parent — their child_name_level dial governs the rendering. */
  parentUserId: string;
  to: string;
  subject: string;
  /** The short quiet-operator body the caller composes; sent verbatim. */
  text: string;
  html?: string;
  /** One line for the calendar entry's DESCRIPTION; dropped when the event is private. */
  note?: string;
  /** REQUEST (default) invites; CANCEL withdraws a previously sent invite. */
  method?: IcsMethod;
}

export interface SendEventInviteDeps {
  database: Database;
  transport: ResendTransport;
  from?: string;
  now?: Date;
}

export type SendEventInviteResult =
  | { status: 'sent'; providerMessageId: string | null; sequence: number }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

/**
 * Emails one event as a calendar invite: the caller's own short body, plus the iTIP
 * object as a `text/calendar` attachment the mail client offers to add. The transport is
 * injected (tests use a fake, no provider is reached).
 *
 * This is deliberately the send only — no ledger row, no quiet-hours check, no consent
 * gate. Production wiring goes through the A2 dispatch, which owns that policy.
 */
export async function sendEventInvite(
  input: SendEventInviteInput,
  deps: SendEventInviteDeps,
): Promise<SendEventInviteResult> {
  const now = deps.now ?? new Date();
  const method = input.method ?? 'REQUEST';

  const row = await loadInviteEventRow(deps.database, input.familyEventId);
  // Family scope (rule #1): the row's OWN family must be the one the caller claims.
  if (!row || row.familyId !== input.familyId) return { status: 'not_found' };
  // A REQUEST for an event that no longer exists would re-add it to the calendar.
  if (method === 'REQUEST' && row.deletedAt !== null) return { status: 'not_found' };

  const [level, sequence] = await Promise.all([
    loadLoopPrefsView(input.parentUserId, deps.database).then((view) => view.childNameLevel),
    icsSequence(deps.database, row.familyId, row.id, method),
  ]);

  const invite = toInviteEvent(row, { level, note: input.note ?? null, sequence }, now);
  const from = deps.from ?? process.env.RESEND_FROM ?? INVITE_FROM;
  const options = {
    organizerEmail: from,
    organizerName: ORGANIZER_NAME,
    attendeeEmail: input.to,
    now,
  };
  const ics = method === 'CANCEL' ? generateEventCancel(invite, options) : generateEventInvite(invite, options);

  const { id, error } = await deps.transport.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: [
      {
        filename: ATTACHMENT_FILENAME,
        content: Buffer.from(ics, 'utf8').toString('base64'),
        contentType: `text/calendar; charset=utf-8; method=${method}`,
      },
    ],
  });

  if (error) return { status: 'error', message: error.message };
  return { status: 'sent', providerMessageId: id, sequence };
}
