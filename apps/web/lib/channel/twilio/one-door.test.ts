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
 * (pre-family sends have no NOT NULL family_id to satisfy). Ops pages go to Slack
 * #ops and are not a phone door. A code review
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
  'api.twilio.com',
  // Linq is the same kind of door: a call here puts bytes on a parent's phone.
  'sendLinqChatMessage(',
  'createLinqChat(',
  'createLinqPhoneTransport(',
  'sendLinqParts(',
  'reactToLinqMessage(',
  'shareLinqContactCard(',
  'requestLinqLocation(',
  'retrieveLinqLocation(',
  'api.linqapp.com',
] as const;

/** Every file allowed to reach Twilio, each with the reason its sends are on the
 * record. "records its own rows" means a channel_messages insert sits beside the
 * transport.send in the same flow; "session transcript" is the intake convention —
 * pre-family sends live on the encrypted intake session and are replayed into
 * channel_messages at provisioning (channel_messages.family_id is NOT NULL, so a
 * pre-family row cannot legally exist earlier). RESIDUE entries are sends with no
 * ledger row today, kept deliberately visible here rather than scattered. */
const ONE_DOOR_ALLOWLIST: Record<string, string> = {
  'apps/web/lib/channel/twilio/transport.ts':
    'the door itself — the one module that speaks Twilio REST',
  'apps/web/lib/channel/outbound-transport.ts':
    'the only production caller of createTwilioTransport; Linq by default (createLinqPhoneTransport), Twilio only when OUTBOUND_TRANSPORT is exactly twilio. Callers ledger beside the send. Exception: claim-code-sender is the pre-existing unledgered sign-in-code residue — the OTP seam returns no provider id and channel_message_category has no honest value for an auth code',
  'apps/web/lib/channel/linq/transport.ts':
    'the iMessage door — the one module that speaks the Linq partner API',
  'apps/web/lib/channel/linq/location-share.ts':
    'reads a shared locality after the parent accepts the location card; retrieveLinqLocation drops the street before return, and the next bubble is the intake transport, not a send from this file',
  'apps/web/lib/channel/linq/contact-card.ts':
    'one-shot Hale Name and Photo share after a finished 1:1 onboard; the claim and the linq_contact_card_shared audit sit beside the share',
  'apps/web/lib/channel/linq/tapback.ts':
    'a tapback that replaces a throwaway ack; the ledger row is written by moments.ts when the reaction is accepted',
  'apps/web/lib/channel/linq/link-preview.ts':
    'a follow-up link part beside locked text; writes its own channel_messages row and linq_link_preview audit when a family id is passed',
  'apps/web/lib/channel/linq/group.ts':
    'opens or extends the household group and writes linq:group_open / linq:group_unreachable plus linq_group_opened or linq_group_held; the unknown-sender hold is the one unledgered text because that sender has no family row to attach it to',
  'apps/web/lib/channel/linq/group-coparent.ts':
    'seats a noted co-parent in a claimed group; sendLine inserts the channel_messages row (reply, dedupe key) before the Linq send and audits sms_reply_sent',
  'apps/web/lib/channel/linq/household-calendar.ts':
    'group notices for kid events, conflicts, handoffs, and how-it-went; sendGroupNotice inserts the channel_messages row before the Linq send',
  'apps/web/lib/channel/coparent/duty/asks.ts':
    'duty asks in the co-parent group; deliverDutyGroupLine inserts the channel_messages row (category duty_ask, provider chat id is the group) before sendLinqChatMessage, and a family with no group returns no_group without calling the transport',
  'apps/web/lib/channel/coparent/duty/ack.ts':
    'duty tapback and one-line restate on the chat the parent just used; acknowledgeDutyWrite inserts the channel_messages row (category reply, template linq:duty_tapback or linq:duty_restate) before reactToLinqMessage or sendLinqChatMessage, and a missing chat id returns no_proactive_1to1 without calling the transport',
  'apps/web/lib/channel/linq/family-outbound.ts':
    'the household outbound resolver; proactive callers ledger the row beside deliverFamilyOutbound, postGroupDecisionSync inserts its own channel_messages row before the Linq send, and sendClaimedGroupLine does the same before mirroring a memory decision into the claimed group only',
  'apps/web/lib/billing/upgrade-ask.ts':
    'year-retention ask and group sync; maybeOfferYearRetention inserts channel_messages (template linq:upgrade_ask) after the Linq send, and closeOffer inserts channel_messages (template linq:upgrade_sync) after the group-sync send',
  'apps/web/lib/channel/linq/poll.ts':
    'sends the placeholder question and the poll, then writes linq:poll and linq_poll_sent',
  'apps/web/lib/channel/router/reply-transport.ts':
    'iMessage arm of the router reply transport; every send ledgered in router route.ts sendReply',
  'apps/web/lib/channel/twilio/delivery-sweep.ts':
    'read-only status poller (P0-1): fetches Message status by SID, sends nothing — its writes are ledger status updates, never provider sends',
  'apps/web/lib/channel/connect/connected-notice.ts':
    'records its own row BEFORE the send and claims the dedupe key with it (reply category, connector:connected) — the connect callback awaits this inside the redirect Google hands back',
  'apps/web/lib/channels/otp-sender.ts':
    'RESIDUE (latent): env-driven CPaaS sender, unconfigured in every environment — claim-code-sender deliberately routes around it. Bound + ledger it before A3 provisions it.',
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
    expect(found).toContain('apps/web/lib/channel/twilio/delivery-sweep.ts');
    expect(found).toContain('apps/web/lib/channel/linq/transport.ts');
  });

  it('no file reaches Twilio outside the allowlisted, ledger-accountable set', () => {
    const strangers = found.filter((file) => !(file in ONE_DOOR_ALLOWLIST));
    expect(
      strangers,
      `These files reach a phone provider (Twilio or Linq) but are not in ONE_DOOR_ALLOWLIST.
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
