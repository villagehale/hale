import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { redactSignupAudit } from './audit';
import type { SignupIdentity, SignupSession } from './types';

/**
 * Slots a signup may share. Phone, medical, and allergy notes are absent.
 * The SQL check on authorized_signup_consents.fields_allowed repeats this list.
 *
 * The parent-facing sentence that would name these slots is offer-copy.ts.
 * That placeholder is never sent.
 */
export const SHAREABLE_SIGNUP_FIELDS = [
  'child_first_name',
  'child_last_name',
  'child_dob',
  'parent_first_name',
  'parent_email',
  'postal_code',
  'session',
  'visit_date',
  'party_size',
  'seating_note',
] as const;

export type ShareableSignupField = (typeof SHAREABLE_SIGNUP_FIELDS)[number];

const SHAREABLE = new Set<string>(SHAREABLE_SIGNUP_FIELDS);

export type SignupConsentRefusal = 'consent_missing' | 'consent_wider' | 'consent_short';

export function signupProviderHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

export function isShareableSignupField(value: string): value is ShareableSignupField {
  return SHAREABLE.has(value);
}

/** Drops duplicates. Returns null when any name is outside the closed list. */
export function normalizeShareFields(fields: readonly string[]): ShareableSignupField[] | null {
  const out: ShareableSignupField[] = [];
  for (const field of fields) {
    if (!isShareableSignupField(field)) return null;
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

/**
 * True when the stored grant lists a slot this action is not typing or packing.
 * The field list is wider than the share, so the run must hand back.
 */
export function fieldListWiderThanTyped(
  allowed: readonly string[],
  typed: readonly string[],
): boolean {
  const typing = new Set(typed);
  return allowed.some((field) => !typing.has(field));
}

/**
 * True when a slot about to be typed or packed is not on the grant.
 * The share would be wider than the field list the parent allowed.
 */
export function typedOutsideGrant(typed: readonly string[], allowed: readonly string[]): boolean {
  const grant = new Set(allowed);
  return typed.some((field) => !grant.has(field));
}

/**
 * Slots this browser or connector run is prepared to type. Only slots that
 * already have a value, plus the session and its visit date when those exist.
 * A handoff pack is narrower and is computed separately.
 */
export function fieldsPreparedToType(
  identity: SignupIdentity,
  session: Pick<SignupSession, 'startsAt' | 'partySize' | 'seatingNote'>,
): ShareableSignupField[] {
  const fields: ShareableSignupField[] = [];
  const add = (field: ShareableSignupField, present: boolean) => {
    if (present) fields.push(field);
  };
  add('child_first_name', Boolean(identity.childFirstName?.trim()));
  add('child_last_name', Boolean(identity.childLastName?.trim()));
  add('child_dob', Boolean(identity.childDob?.trim()));
  add('parent_first_name', Boolean(identity.parentFirstName?.trim()));
  add('parent_email', Boolean(identity.parentEmail?.trim()));
  add('postal_code', Boolean(identity.postalCode?.trim()));
  add('session', true);
  add('visit_date', /^\d{4}-\d{2}-\d{2}/.test(session.startsAt));
  const partySize = session.partySize ?? null;
  add('party_size', typeof partySize === 'number' && partySize >= 1);
  add('seating_note', Boolean(session.seatingNote?.trim()));
  return fields;
}

export type EnsureSignupConsentResult =
  | { ok: true; fieldsAllowed: ShareableSignupField[] }
  | { ok: false; reason: SignupConsentRefusal };

/**
 * Records the grant from this yes, then reads it back.
 *
 * A missing message id writes nothing. An existing row is not replaced: if
 * its field list is wider than the slots this action will type, or this
 * action would type a slot the row does not list, the run refuses.
 */
export async function ensureSignupConsent(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    messageId: string | null;
    activityKey: string;
    providerHost: string;
    fieldsAllowed: readonly string[];
    now: Date;
  },
): Promise<EnsureSignupConsentResult> {
  const messageId = input.messageId?.trim() ?? '';
  const providerHost = signupProviderHost(input.providerHost);
  if (!messageId || messageId.length > 200 || !providerHost || providerHost.length > 253) {
    return { ok: false, reason: 'consent_missing' };
  }
  const fields = normalizeShareFields(input.fieldsAllowed);
  if (!fields) return { ok: false, reason: 'consent_short' };

  const inserted = await database
    .insert(schema.authorizedSignupConsents)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      messageId,
      activityKey: input.activityKey,
      providerHost,
      fieldsAllowed: fields,
      createdAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        schema.authorizedSignupConsents.familyId,
        schema.authorizedSignupConsents.messageId,
        schema.authorizedSignupConsents.activityKey,
        schema.authorizedSignupConsents.providerHost,
      ],
    })
    .returning({ id: schema.authorizedSignupConsents.id });

  const created = inserted[0];
  if (created) {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'authorized_signup_step',
      targetTable: 'authorized_signup_consents',
      targetId: created.id,
      after: redactSignupAudit({
        step: 'consent',
        activityKey: input.activityKey,
        host: providerHost,
        fields,
      }),
    });
  }

  const [row] = await database
    .select({
      fieldsAllowed: schema.authorizedSignupConsents.fieldsAllowed,
      familyId: schema.authorizedSignupConsents.familyId,
      messageId: schema.authorizedSignupConsents.messageId,
      activityKey: schema.authorizedSignupConsents.activityKey,
      providerHost: schema.authorizedSignupConsents.providerHost,
    })
    .from(schema.authorizedSignupConsents)
    .where(
      and(
        eq(schema.authorizedSignupConsents.familyId, input.familyId),
        eq(schema.authorizedSignupConsents.messageId, messageId),
        eq(schema.authorizedSignupConsents.activityKey, input.activityKey),
        eq(schema.authorizedSignupConsents.providerHost, providerHost),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.familyId !== input.familyId ||
    row.messageId !== messageId ||
    row.activityKey !== input.activityKey ||
    row.providerHost !== providerHost
  ) {
    return { ok: false, reason: 'consent_missing' };
  }
  const stored = normalizeShareFields(row.fieldsAllowed);
  if (!stored) return { ok: false, reason: 'consent_wider' };
  if (fieldListWiderThanTyped(stored, fields)) return { ok: false, reason: 'consent_wider' };
  if (typedOutsideGrant(fields, stored)) return { ok: false, reason: 'consent_short' };
  return { ok: true, fieldsAllowed: stored };
}
