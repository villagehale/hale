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
