#!/usr/bin/env tsx
// Live probe for the VIL-219 ICS calendar-subscription feed. Exercises the REAL feed
// path against ONE real family: mint the tokenized URL, load the feed through
// loadIcsFeed (the same read the /api/ics/[token] route serves), parse it with a real
// RFC-5545 parser (node-ical), and assert the privacy invariants (rule #1) hold on
// live data — NO child surname in any title, and every teen child's placement renders
// generic. Then prints the subscription URL for a manual Google Calendar "Add by URL"
// check. A second run with --revoke nulls the token and proves the feed goes dead.
//
// Secrets come ONLY from the environment — never inlined, never read from
// .loop/launch.env by this script:
//   DATABASE_URL=... [PROBE_BASE_URL=https://villagehale.com] \
//     pnpm --filter @hale/web probe:ics-feed <family-id> [--revoke]
//
// Manual Google Calendar step (after the default run prints the URL):
//   Google Calendar → Other calendars → + → "From URL" → paste the printed URL →
//   Add calendar. The family's placements/occasions should appear; a teen child's
//   entry shows "A private calendar item" (no name). Then run with --revoke and
//   confirm Google stops refreshing the feed (the URL 404s).
//
// Exits nonzero on any failed invariant so it gates cleanly.

import { createDb, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { eq } from 'drizzle-orm';
import ical from 'node-ical';
import { loadIcsFeed, mintIcsToken, revokeIcsToken } from '../lib/loop/ics-feed';

const familyId = process.argv[2];
const revoke = process.argv.includes('--revoke');
if (!familyId) {
  console.error('usage: probe:ics-feed <family-id> [--revoke]');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const baseUrl = process.env.PROBE_BASE_URL ?? 'https://villagehale.com';

const db = createDb({ connectionString: url });
const now = new Date();

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

try {
  if (revoke) {
    const killed = await revokeIcsToken(db, familyId);
    const feed = await feedForFamily(familyId);
    if (feed !== null) fail('feed still resolves after revocation — the token was not killed.');
    console.log(`revoked=${killed}; feed after revocation = null (dead). OK.`);
    process.exit(0);
  }

  const { token } = await mintIcsToken(db, familyId);
  const ics = await loadIcsFeed(db, token, now);
  if (ics === null) fail('loadIcsFeed returned null for the freshly-minted token.');

  // Real-parser validity: the feed must parse and expose VEVENTs (or be empty).
  const parsed = ical.parseICS(ics);
  const vevents = Object.values(parsed).filter((c) => c?.type === 'VEVENT');
  console.log(`token=${token}`);
  console.log(`parsed VEVENTs: ${vevents.length}`);

  // rule #1: no child SURNAME may appear in any title, and a teen child's placement
  // must render generic. Pull the family's children live to check against real names.
  const children = await db
    .select({
      name: schema.children.name,
      lastName: schema.children.lastName,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  for (const child of children) {
    if (child.lastName && ics.includes(child.lastName)) {
      fail(`child surname "${child.lastName}" leaked into the ICS feed (rule #1).`);
    }
    const isTeen = deriveStage(child.dateOfBirth, now) === 'teenager';
    if (isTeen && child.name && ics.includes(child.name)) {
      fail(`teen child first name "${child.name}" appears in the feed — should be generic.`);
    }
  }
  console.log(`children checked: ${children.length} (no surname leak; teen names generic). OK.`);

  console.log('\nSubscription URL (paste into Google Calendar → From URL):');
  console.log(`  ${baseUrl}/api/ics/${token}`);
  console.log('\nThen re-run with --revoke to confirm the feed goes dead.');
  process.exit(0);
} catch (err) {
  console.error('probe threw:', err);
  process.exit(1);
}

/** The feed the /api/ics/[token] route would serve for this family's CURRENT token,
 * or null if the token was revoked. Reads the token straight off the family row. */
async function feedForFamily(fid: string): Promise<string | null> {
  const rows = await db
    .select({ token: schema.families.icsShareToken })
    .from(schema.families)
    .where(eq(schema.families.id, fid))
    .limit(1);
  const token = rows[0]?.token;
  if (!token) return null;
  return loadIcsFeed(db, token, now);
}
