#!/usr/bin/env tsx
// The inbound canary's household — DATA, not schema. One families row, one
// users row, one primary_parent membership, and one ACTIVE VERIFIED sms channel
// for CANARY_PHONE_E164 (+1 437-555-0100, inside the operator's synthetic probe
// range, so the founder ping and the village intro sweep already exclude it).
// No children, no province, no email address (users.email is nullable exactly
// for an SMS-provisioned parent), and the onboarding stage left at its
// 'pending_invite' default: every per-family cron iterates this row, and the
// four proactive senders that TEXT — registration-sequence, village intros,
// nudge, followup — all gate on stage 'sms_active'. A household with nothing in
// it and no stage has nothing to send. The inbound reply path reads none of
// those, so the turn the canary exists to exercise is unaffected.
//
// IDEMPOTENT ON THE BLIND INDEX — the same key the door resolves an inbound
// `From` with. Re-running against a seeded database prints the family id and
// writes nothing. A row that exists but is revoked or unverified is reported
// and FAILS: the canary would silently claim nothing while the cron kept
// injecting, and "it ran without error" must never mean that.
//
// Unlike seed-e2e-smoke.ts this one is MEANT for prod — so the guard is
// inverted: a non-local DATABASE_URL needs an explicit --i-mean-prod.

import { createDb, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { CANARY_PHONE_E164 } from '../lib/channel/canary/config';
import { phoneBlindIndex } from '../lib/crypto/blind-index';
import { encryptString } from '../lib/crypto/string-cipher';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('seed-inbound-canary: DATABASE_URL is not set.');
  process.exit(1);
}
const host = new URL(url).hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1';
if (!isLocal && !process.argv.includes('--i-mean-prod')) {
  console.error(
    `seed-inbound-canary: refusing non-local database host "${host}" without --i-mean-prod — this writes a real household to the roster.`,
  );
  process.exit(1);
}

const db = createDb({ connectionString: url });
const hash = phoneBlindIndex(CANARY_PHONE_E164);

const [existing] = await db
  .select({
    familyId: schema.parentChannels.familyId,
    verifiedAt: schema.parentChannels.verifiedAt,
    revokedAt: schema.parentChannels.revokedAt,
  })
  .from(schema.parentChannels)
  .where(eq(schema.parentChannels.phoneE164Hash, hash))
  .limit(1);

if (existing) {
  if (!existing.verifiedAt || existing.revokedAt !== null) {
    console.error(
      `seed-inbound-canary: the canary channel exists on family ${existing.familyId} but is not active (verified=${Boolean(existing.verifiedAt)}, revoked=${existing.revokedAt !== null}). Re-activate it deliberately; the canary claims nothing while it is in this state.`,
    );
    process.exit(1);
  }
  console.log(`seed-inbound-canary: already seeded. family=${existing.familyId}`);
  process.exit(0);
}

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`seed-inbound-canary: insert returned no row for ${what}`);
  return row;
}

const family = one(
  await db
    .insert(schema.families)
    .values({ displayName: 'Hale inbound canary' })
    .returning({ id: schema.families.id }),
  'family',
);
const user = one(
  await db
    .insert(schema.users)
    .values({ name: 'Canary' })
    .returning({ id: schema.users.id }),
  'user',
);
await db.insert(schema.familyMembers).values({
  familyId: family.id,
  userId: user.id,
  role: 'primary_parent',
});
await db.insert(schema.parentChannels).values({
  userId: user.id,
  familyId: family.id,
  kind: 'sms',
  phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
  phoneE164Hash: hash,
  verifiedAt: new Date(),
});

// Printed for the run log only: nothing reads a canary family id from an env
// var — both halves resolve the household through the blind index above.
console.log(`seed-inbound-canary: seeded. family=${family.id}`);
process.exit(0);
