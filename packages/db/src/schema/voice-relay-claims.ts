import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per call that has been let onto the voice relay socket — the thing that makes
 * a relay ticket single-USE rather than merely short-lived.
 *
 * The ticket (apps/web/lib/channel/twilio/relay-token.ts) is a signed bearer string that
 * rides in a `wss://` url, and Twilio stores and logs urls. Signature plus expiry proves
 * a ticket was minted by the verified webhook; it cannot prove it is being presented for
 * the first time. Within the two-minute window a second connect could hand over the same
 * string and be believed. An in-process `Set` would not help: Vercel Fluid runs many
 * instances and the replay would simply land on another one. So the fact lives where all
 * the instances can see it — a row, and a unique index that makes the INSERT the claim.
 *
 * Family-AGNOSTIC ops data, like the rate_limits and registration_verify_runs claims it
 * sits beside: a CallSid is an opaque provider handle with no number, no name and no
 * family in it, and rows age out in a day (a call is capped at nine minutes). Nothing
 * here is reachable by, or in need of, a right-to-erasure sweep. Rule #1.
 *
 * The refusal itself is not silent — the call it belonged to gets an audit_log row
 * naming the replay, which is the half a family's own trail can show.
 */
export const voiceRelayClaims = pgTable(
  'voice_relay_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Twilio's id for the call. Globally unique and never reused. */
    callSid: text('call_sid').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    callSidIdx: uniqueIndex('voice_relay_claims_call_sid_uniq').on(table.callSid),
  }),
);

export type VoiceRelayClaim = typeof voiceRelayClaims.$inferSelect;
export type NewVoiceRelayClaim = typeof voiceRelayClaims.$inferInsert;
