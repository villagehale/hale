#!/usr/bin/env tsx
// Fixture seed for the CI web-smoke walk (the #577 class: real authed flag-on
// renders). Two PII-free accounts, keyed by external_auth_id so the minted
// session cookies resolve them:
//
//   smoke-admin  — primary parent + toddler + an ACTIVE VERIFIED sms channel whose
//                  blind index matches ADMIN_PHONES, so /admin opens for this user.
//   smoke-parent — primary parent + preschooler, no admin phone (the /admin 404 leg).
//
// The channel row encrypts/hashes through the same lib/crypto modules the admin
// gate reads, so the hash matches by construction (same module, same env key).
// Idempotent: re-running deletes the two accounts' families (cascade) and re-seeds.
//
// Refuses any non-local DATABASE_URL: this seed exists for ephemeral smoke
// databases only and must never run against prod.

import { createDb, schema } from '@hale/db';
import { inArray } from 'drizzle-orm';
import { normalizePhoneE164 } from '../lib/channels/phone';
import { phoneBlindIndex } from '../lib/crypto/blind-index';
import { encryptString } from '../lib/crypto/string-cipher';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('seed-e2e-smoke: DATABASE_URL is not set.');
  process.exit(1);
}
const host = new URL(url).hostname;
if (host !== 'localhost' && host !== '127.0.0.1') {
  console.error(
    `seed-e2e-smoke: refusing non-local database host "${host}" — this seed is for ephemeral smoke databases only.`,
  );
  process.exit(1);
}

const adminPhoneRaw = process.env.ADMIN_PHONES?.split(',')[0]?.trim();
const adminPhone = adminPhoneRaw ? normalizePhoneE164(adminPhoneRaw) : null;
if (!adminPhone) {
  console.error(
    'seed-e2e-smoke: ADMIN_PHONES must carry a valid CA/US E.164 number — the /admin leg keys the fixture channel off it.',
  );
  process.exit(1);
}

const EXTERNAL_IDS = ['smoke-admin', 'smoke-parent'];

/** date-only string N months before now (UTC) — feeds deriveStage. */
function dobMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const db = createDb({ connectionString: url });

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`seed-e2e-smoke: insert returned no row for ${what}`);
  return row;
}

// ── Idempotent cleanup: the two fixture accounts and their families ──
const existing = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(inArray(schema.users.externalAuthId, EXTERNAL_IDS));
if (existing.length > 0) {
  const userIds = existing.map((row) => row.id);
  const memberships = await db
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(inArray(schema.familyMembers.userId, userIds));
  const familyIds = [...new Set(memberships.map((row) => row.familyId))];
  if (familyIds.length > 0) {
    await db.delete(schema.families).where(inArray(schema.families.id, familyIds));
  }
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
}

// ── smoke-admin: family + toddler + allowlisted verified sms channel ──
const adminUser = one(
  await db
    .insert(schema.users)
    .values({ externalAuthId: 'smoke-admin', email: 'smoke-admin@example.test', name: 'Sam Smoke' })
    .returning({ id: schema.users.id }),
  'smoke-admin user',
);
const adminFamily = one(
  await db
    .insert(schema.families)
    .values({ displayName: 'Smoke', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id }),
  'smoke-admin family',
);
await db.insert(schema.familyMembers).values({
  familyId: adminFamily.id,
  userId: adminUser.id,
  role: 'primary_parent',
});
await db.insert(schema.children).values({
  familyId: adminFamily.id,
  name: 'Juniper',
  dateOfBirth: dobMonthsAgo(26),
});
await db.insert(schema.parentChannels).values({
  userId: adminUser.id,
  familyId: adminFamily.id,
  kind: 'sms',
  phoneE164Encrypted: encryptString(adminPhone),
  phoneE164Hash: phoneBlindIndex(adminPhone),
  verifiedAt: new Date(),
});

// ── smoke-parent: family + preschooler, no channel (never an admin) ──
const parentUser = one(
  await db
    .insert(schema.users)
    .values({ externalAuthId: 'smoke-parent', email: 'smoke-parent@example.test', name: 'Pat Smoke' })
    .returning({ id: schema.users.id }),
  'smoke-parent user',
);
const parentFamily = one(
  await db
    .insert(schema.families)
    .values({ displayName: 'Smoke Two', onboardingStage: 'sms_active' })
    .returning({ id: schema.families.id }),
  'smoke-parent family',
);
await db.insert(schema.familyMembers).values({
  familyId: parentFamily.id,
  userId: parentUser.id,
  role: 'primary_parent',
});
await db.insert(schema.children).values({
  familyId: parentFamily.id,
  name: 'Wren',
  dateOfBirth: dobMonthsAgo(40),
});

console.log('seed-e2e-smoke: seeded smoke-admin (Juniper) and smoke-parent (Wren).');
process.exit(0);
