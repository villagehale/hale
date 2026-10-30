/**
 * VIL-335 — Linq credentials, read in one place and never logged.
 *
 * Two secrets, two jobs:
 *   - LINQ_WEBHOOK_SECRET — the subscription's `whsec_` signing secret. Inbound
 *     verification only. Linq shows it once, when the subscription is created.
 *   - LINQ_API_KEY — the partner API bearer token. Outbound replies only.
 *
 * ALL-OR-NOTHING for the inbound door. A deploy holding the signing secret and no
 * API key would accept a parent's iMessage and then fail the reply. Absent config
 * is a clean 503 (`linq_not_configured`); half-present config is the same 503.
 * Values are trimmed — `vercel env add` stores a trailing newline, and that must
 * read as configured.
 */

function trimmed(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

export function linqApiKey(): string | null {
  return trimmed('LINQ_API_KEY');
}

export function linqWebhookSecret(): string | null {
  return trimmed('LINQ_WEBHOOK_SECRET');
}

/** Names only, never values. Empty when the inbound door may open. */
export function linqMissingInboundEnv(): string[] {
  const missing: string[] = [];
  if (!linqApiKey()) missing.push('LINQ_API_KEY');
  if (!linqWebhookSecret()) missing.push('LINQ_WEBHOOK_SECRET');
  return missing;
}

export function linqInboundConfigured(): boolean {
  return linqMissingInboundEnv().length === 0;
}

/**
 * The Hale line that opens a group chat (`from` on POST /chats). Absent is
 * named `no_from` by the group opener — a group cannot be created without it,
 * and the number is never hardcoded.
 */
export function linqFromE164(): string | null {
  return trimmed('LINQ_FROM_E164');
}

/**
 * A phone-addressed outbound send needs both the partner key and the Hale
 * line. Either one missing is the same dark leg: there is no half-send.
 */
export function linqPhoneOutboundConfigured(): boolean {
  return linqApiKey() !== null && linqFromE164() !== null;
}

/**
 * Polls ship only when this is exactly `on`. Anything else, including unset, is off.
 * This tree does not set the flag. Ops turns LINQ_POLLS on after the poll PR ships.
 */
export function linqPollsEnabled(): boolean {
  return trimmed('LINQ_POLLS') === 'on';
}

/**
 * In-group co-parent seating and household calendar notices on the Linq
 * channel. On unless `LINQ_GROUP_COPARENT` is exactly `off` (kill switch).
 * Unset, empty, and `on` all enable it. SMS never reads this flag.
 */
export function linqGroupCoparentEnabled(): boolean {
  return trimmed('LINQ_GROUP_COPARENT') !== 'off';
}

/**
 * Unlimited household-group seats (VIL-398). Exactly `true` enables it.
 * Unset, empty, `on`, and `false` stay dark. Default off.
 */
export function linqGroupMembersEnabled(): boolean {
  return trimmed('LINQ_GROUP_MEMBERS_ENABLED') === 'true';
}

/**
 * Shared Linq groups that hold more than one family (VIL-399). Exactly `true`
 * enables it. Unset, empty, `on`, and `false` stay dark. Default off.
 * While dark, a phone from another family is still refused by the household
 * seat.
 */
export function linqMultiFamilyGroupsEnabled(): boolean {
  return trimmed('LINQ_MULTI_FAMILY_GROUPS_ENABLED') === 'true';
}

/**
 * Group onboarding v2: Hale reads who is in a group it was added to and asks who is
 * who. Exactly `true` enables it. Unset, empty, `on`, and `false` stay dark. Default
 * off. Off means no roster step runs and the door answers as it did before.
 */
export function linqGroupOnboardingV2Enabled(): boolean {
  return trimmed('LINQ_GROUP_ONBOARDING_V2_ENABLED') === 'true';
}

/**
 * VIL-438 (T22) — the new-member welcome is written by the model from facts
 * (`member_welcome`) instead of the fixed line. Exactly `true` enables it. Default off:
 * off keeps today's welcome byte-for-byte, so no eval re-record is needed to merge.
 */
export function linqGroupWelcomeVoiceEnabled(): boolean {
  return trimmed('LINQ_GROUP_WELCOME_VOICE_ENABLED') === 'true';
}

/**
 * VIL-444 (T24) — a clash in the household group gets one model-written alert with a
 * suggested fix, in place of the household conflict line, and a pickup someone takes in
 * that group settles it (group-pickup-claim.ts). Exactly `true` enables it.
 * Default off: off plans and sends exactly what it did before.
 */
export function linqGroupConflictAlertsEnabled(): boolean {
  return trimmed('LINQ_GROUP_CONFLICT_ALERTS_ENABLED') === 'true';
}

/**
 * VIL-442 (T15) — RSVP tracking for any plan in a Linq group. Exactly `true`
 * enables it. Unset, empty, `on`, and `false` stay dark. Default off.
 */
export function linqGroupPlanRsvpEnabled(): boolean {
  return trimmed('LINQ_GROUP_PLAN_RSVP_ENABLED') === 'true';
}

/**
 * VIL-471 — parent-made polls in a Linq group, read in the same group turn as
 * plan RSVPs. Exactly `true` enables it. Unset, empty, `on`, and `false` stay
 * dark. Default off. The native poll card additionally needs LINQ_POLLS.
 */
export function linqGroupPollsEnabled(): boolean {
  return trimmed('LINQ_GROUP_POLLS_ENABLED') === 'true';
}

/**
 * VIL-476 — native iMessage voice memos: an iMessage capability check (cached) and the
 * voice-memo send, plus inbound audio named as a voice memo for the model. Exactly
 * `true` enables it. Unset, empty, `on`, and `false` stay dark. Default off: off reads
 * inbound audio as a `file` and never calls the capability or voice-memo endpoints.
 */
export function linqVoiceMemosEnabled(): boolean {
  return trimmed('LINQ_VOICE_MEMOS_ENABLED') === 'true';
}

/**
 * VIL-480 — iMessage app cards (an `imessage_app` part instead of a bare link preview).
 * Exactly `true` enables it. Unset, empty, `on`, and `false` stay dark. Default off: off
 * never sends an app part and reads an inbound app card exactly as before (a `file`).
 */
export function linqAppCardsEnabled(): boolean {
  return trimmed('LINQ_APP_CARDS_ENABLED') === 'true';
}

/**
 * VIL-480 — the Messages extension that draws Hale's cards. Linq renders a card as the
 * app named by team id + bundle id; an identity that matches no installed extension
 * silently drops to caption text. All three of name, team id, and bundle id are needed;
 * any one missing is null (no card, the caller falls back). Never hardcoded.
 */
export function linqIMessageAppIdentity(): {
  name: string;
  team_id: string;
  bundle_id: string;
  app_store_id?: number;
} | null {
  const name = trimmed('LINQ_IMESSAGE_APP_NAME');
  const teamId = trimmed('LINQ_IMESSAGE_APP_TEAM_ID');
  const bundleId = trimmed('LINQ_IMESSAGE_APP_BUNDLE_ID');
  if (!name || !teamId || !bundleId) return null;
  if (name.length > 64 || !/^[A-Z0-9]{10}$/.test(teamId)) return null;
  const storeId = Number(trimmed('LINQ_IMESSAGE_APP_STORE_ID') ?? '');
  return {
    name,
    team_id: teamId,
    bundle_id: bundleId,
    ...(Number.isInteger(storeId) && storeId > 0 ? { app_store_id: storeId } : {}),
  };
}
