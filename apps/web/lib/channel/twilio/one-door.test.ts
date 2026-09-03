import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONE DOOR TO THE PROVIDER — the structural half of the 2026-09-03 SMS reliability
 * audit's P0-2 (rule #6 exposure: prod showed ~85% of real outbound SMS bypassing the
 * channel_messages ledger — 30d: 177 Twilio outbound vs 25 ledger rows).
 *
 * The invariant: every module that can put bytes on a parent's phone either writes a
 * channel_messages row for each send, or is a NAMED residue with a structural reason
 * (pre-family sends have no NOT NULL family_id to satisfy; the founder alert is
 * DB-independent by design because it fires when the DB is down). A code review
 * cannot keep that true as the codebase grows, so it is a test: constructing a Twilio
 * transport — or reaching Twilio REST directly — in any file not on this list fails
 * here, loudly, with the question the new file must answer ("where is your ledger
 * row?"). Same shape as teen-access-outbound.test.ts, for the same reason.
 *
 * Adding a file to the allowlist is a deliberate act: the justification string is the
 * reviewer's contract that the new sender ledgers every send (or is a new structural
 * residue, which wants pushback first).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');

/** How a file can reach the provider: constructing a transport, or raw REST. The
 * construction tokens carry the open paren so prose mentions in comments (keywords.ts,
 * alert.ts) don't count as reaching anything. */
const PROVIDER_TOKENS = [
  'createTwilioTransport(',
  'createTwilioWhatsAppTransport(',
  'api.twilio.com',
] as const;

/** Every file allowed to reach Twilio, each with the reason its sends are on the
 * record. "records its own rows" means a channel_messages insert sits beside the
 * transport.send in the same flow; "session transcript" is the intake convention —
 * pre-family sends live on the encrypted intake session and are replayed into
 * channel_messages at provisioning (channel_messages.family_id is NOT NULL, so a
 * pre-family row cannot legally exist earlier). RESIDUE entries are sends with no
 * ledger row today, kept deliberately visible here rather than scattered. */
const ONE_DOOR_ALLOWLIST: Record<string, string> = {
  'apps/web/lib/channel/twilio/transport.ts': 'the door itself — the one module that speaks Twilio REST',
  'apps/web/lib/channel/twilio/deps.ts':
    'intake + voice wiring; intake sends record via machine.ts writeChannelMessage or the session transcript, voice via textStranger transcript',
  'apps/web/lib/channel/router/wiring.ts':
    'coach reply transport; every send ledgered in router route.ts sendReply',
  'apps/web/lib/channel/adapters/twilio-sms.ts':
    'loop dispatch adapter; every leg ledgered by dispatch.ts writeLedgerRow',
  'apps/web/lib/registration/sequence/run.ts': 'records its own rows (recordSend port)',
  'apps/web/lib/party/reminders.ts': 'records its own rows (rsvp category)',
  'apps/web/lib/village/intros/run.ts': 'records its own rows (village_intro category)',
  'apps/web/lib/channel/founder/reply.ts': 'records its own rows (founder category)',
  'apps/web/lib/channel/followup/run.ts': 'records its own rows (followup category)',
  'apps/web/lib/channel/plan/check-in.ts': 'records its own rows (plan_check_in category)',
  'apps/web/lib/channel/activity/sweep.ts':
    'records via deliverFollowUp recordSend port (activity_followup category)',
  'apps/web/lib/channel/nudge/run.ts': 'records its own rows (nudge category)',
  'apps/web/lib/channel/intake/first-reply-recovery.ts':
    'pre-family by eligibility (family_id IS NULL); session transcript, replayed at provisioning',
  'apps/web/lib/channel/intake/sitting-reminder.ts':
    'pre-family by eligibility (family_id IS NULL); session transcript, replayed at provisioning',
  'apps/web/lib/auth/claim-code-sender.ts':
    'RESIDUE: sign-in codes are unledgered. The claim flow resolves userId+familyId before sending, but the OTP seam returns no provider id and channel_message_category has no honest value for an auth code. Closing this needs an additive category migration + provider-id plumbing — its own change, not a quiet edit here.',
  'apps/web/lib/channels/otp-sender.ts':
    'RESIDUE (latent): env-driven CPaaS sender, unconfigured in every environment — claim-code-sender deliberately routes around it. Bound + ledger it before A3 provisions it.',
  'apps/web/lib/channel/twilio/alert.ts':
    'RESIDUE BY DESIGN: the founder webhook-failure alert is database-independent on purpose — it fires when the DB is down (2026-08-28), so a ledger write is structurally impossible. Founder-directed, digit-scrubbed, rate-limited.',
  'apps/web/lib/monitoring/twilio-triage.ts':
    'RESIDUE BY DESIGN: founder diagnosis SMS for Twilio Monitor alerts — same ops class as alert.ts, founder-directed, not family traffic.',
};

/** The trees a send could hide in. Worker is scanned even though it has no Twilio
 * today — the day someone gives it a transport, this test is the reviewer. */
const SCAN_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/web/scripts',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function filesReachingProvider(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const text = readFileSync(file, 'utf8');
      if (PROVIDER_TOKENS.some((token) => text.includes(token))) {
        found.push(file.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return found.sort();
}

describe('one door to the provider (rule #6)', () => {
  const found = filesReachingProvider();

  it('positive control: the scanner sees the door itself', () => {
    // A scan that cannot find transport.ts is a broken scanner, not a clean repo —
    // every assertion below would pass vacuously ("a refusal is not evidence").
    expect(found).toContain('apps/web/lib/channel/twilio/transport.ts');
    expect(found).toContain('apps/web/lib/channel/twilio/alert.ts');
  });

  it('no file reaches Twilio outside the allowlisted, ledger-accountable set', () => {
    const strangers = found.filter((file) => !(file in ONE_DOOR_ALLOWLIST));
    expect(
      strangers,
      `These files reach the Twilio provider but are not in ONE_DOOR_ALLOWLIST.
Every send must write a channel_messages row (rule #6). Route the send through an existing ledgered path, or add the file here WITH the justification that names where its ledger row is written:
  ${strangers.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const foundSet = new Set(found);
    const stale = Object.keys(ONE_DOOR_ALLOWLIST).filter((file) => !foundSet.has(file));
    expect(
      stale,
      `These ONE_DOOR_ALLOWLIST entries no longer reach the provider — remove them so the list stays the real inventory:
  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
