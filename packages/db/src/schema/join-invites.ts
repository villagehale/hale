import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { familyRoleEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * The forwardable co-parent join link: a capability a parent hands to their partner in
 * their OWN thread, redeemed by the partner texting Hale from their own number.
 *
 * WHY IT IS NOT A CAREGIVER INVITE. `caregiver_invites` holds a NUMBER a parent typed,
 * because Hale is the one who texts it — a double opt-in across two conversations. This
 * row holds no number at all, and that is the whole design: nobody is contacted, so
 * there is nothing to consent to yet. The parent forwards the link themselves and the
 * partner's own first message is their CASL basis, exactly as it is for a QR card.
 *
 * WHY ONLY A HASH (rule #1). Whoever holds the raw token becomes a co-parent of this
 * family — full scope, everything Hale shows the parent who asked. That makes it the
 * same class of secret as a magic link, so it is stored the same way: SHA-256 of the
 * token, never the token, so a database read can never reconstruct a usable link.
 * Redemption hashes what arrived and looks the digest up.
 *
 * SINGLE USE, SEVEN DAYS. `consumed_at` burns it on redemption and `expires_at` bounds
 * it; both are checked ON READ, so a sweep that never runs cannot leave a dead link
 * live. A link that fails either check is not an error — the person holding it gets the
 * ordinary greeting, because a stranger with a stale forward is a stranger, not a fault.
 *
 * NO display_name, NO phone: nobody has been named or contacted. The only thing this
 * row asserts is that a named parent asked for one co-parent seat in their household.
 */
export const joinInvites = pgTable(
  'join_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The parent who asked. Their request IS the authorization, recorded alongside as
     * a `co_parent_access_grant` consent row. */
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 (hex) of the lowercased `join-<token>` code. Never the token itself. */
    tokenHash: text('token_hash').notNull().unique(),
    /** Fixed to 'co_parent' in v1, stored rather than assumed so the grant the parent
     * consented to and the membership that lands cannot diverge. */
    role: familyRoleEnum('role').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on redemption — the burn that makes the link single-use. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The users row minted for (or matched to) whoever redeemed it. */
    consumedByUserId: uuid('consumed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('join_invites_family_idx').on(table.familyId),
  }),
);

export type JoinInvite = typeof joinInvites.$inferSelect;
export type NewJoinInvite = typeof joinInvites.$inferInsert;
