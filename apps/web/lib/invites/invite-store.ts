import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';

const TOKEN_BYTES = 18;
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_ROLE: FamilyRole = 'co_parent';

type FamilyRole = (typeof schema.familyRoleEnum.enumValues)[number];

export interface InviteRow {
  id: string;
  familyId: string;
  token: string;
  email: string | null;
  role: FamilyRole;
  createdByUserId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
}

export interface NewInviteRow {
  familyId: string;
  token: string;
  email: string | null;
  role: FamilyRole;
  createdByUserId: string;
  expiresAt: Date;
}

export interface AddMemberArgs {
  familyId: string;
  userId: string;
  role: FamilyRole;
  invitedByUserId: string;
}

export interface MarkAcceptedArgs {
  inviteId: string;
  userId: string;
  now: Date;
}

/**
 * Minimal db surface the invite store needs. Injected so the create/accept logic
 * is unit-testable without a live Postgres connection (mirrors WaitlistDb).
 */
export interface InviteDb {
  insertInvite(row: NewInviteRow): Promise<{ id: string }>;
  findInviteByToken(token: string): Promise<InviteRow | null>;
  addMember(args: AddMemberArgs): Promise<void>;
  markAccepted(args: MarkAcceptedArgs): Promise<void>;
}

export interface CreateInviteArgs {
  familyId: string;
  createdByUserId: string;
  email?: string;
  role?: FamilyRole;
  now?: Date;
}

export type AcceptResult =
  | { status: 'accepted'; familyId: string; alreadyMember: boolean }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_accepted' }
  | { status: 'wrong_recipient' };

export interface InviteStore {
  createInvite(args: CreateInviteArgs): Promise<{ id: string; token: string; expiresAt: Date }>;
  acceptInvite(args: {
    token: string;
    userId: string;
    email?: string;
    now?: Date;
  }): Promise<AcceptResult>;
}

export function createInviteStore(db: InviteDb): InviteStore {
  return {
    async createInvite(args) {
      const now = args.now ?? new Date();
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(now.getTime() + EXPIRY_MS);
      const { id } = await db.insertInvite({
        familyId: args.familyId,
        token,
        email: args.email ?? null,
        role: args.role ?? DEFAULT_ROLE,
        createdByUserId: args.createdByUserId,
        expiresAt,
      });
      return { id, token, expiresAt };
    },

    async acceptInvite({ token, userId, email, now = new Date() }) {
      const invite = await db.findInviteByToken(token);
      if (!invite) {
        return { status: 'not_found' };
      }

      // A targeted invite (email set) may be accepted only by that email
      // (case-insensitive). An untargeted invite (null email) is open to any
      // signed-in user, preserving the single-parent-onboarding flow.
      if (invite.email !== null && invite.email.toLowerCase() !== email?.toLowerCase()) {
        return { status: 'wrong_recipient' };
      }

      if (invite.acceptedAt) {
        // Single-use token: re-accept by the same user is the idempotent success
        // path (alreadyMember: no new membership change to audit); any other user
        // is refused.
        if (invite.acceptedByUserId === userId) {
          return { status: 'accepted', familyId: invite.familyId, alreadyMember: true };
        }
        return { status: 'already_accepted' };
      }

      if (invite.expiresAt.getTime() <= now.getTime()) {
        return { status: 'expired' };
      }

      await db.addMember({
        familyId: invite.familyId,
        userId,
        role: invite.role,
        invitedByUserId: invite.createdByUserId,
      });
      await db.markAccepted({ inviteId: invite.id, userId, now });
      return { status: 'accepted', familyId: invite.familyId, alreadyMember: false };
    },
  };
}

/**
 * Builds the real InviteDb backed by Drizzle. addMember dedups on the
 * (family_id, user_id) primary key so a redo never errors (idempotency at the db
 * level); markAccepted only stamps a row not yet accepted, so concurrent
 * redemptions cannot both win the member write twice.
 */
export function inviteDbFromDatabase(database: Database): InviteDb {
  return {
    async insertInvite(row) {
      const [inserted] = await database
        .insert(schema.familyInvites)
        .values(row)
        .returning({ id: schema.familyInvites.id });
      if (!inserted) {
        throw new Error('insertInvite returned no row');
      }
      return { id: inserted.id };
    },

    async findInviteByToken(token) {
      const rows = await database
        .select({
          id: schema.familyInvites.id,
          familyId: schema.familyInvites.familyId,
          token: schema.familyInvites.token,
          email: schema.familyInvites.email,
          role: schema.familyInvites.role,
          createdByUserId: schema.familyInvites.createdByUserId,
          expiresAt: schema.familyInvites.expiresAt,
          acceptedAt: schema.familyInvites.acceptedAt,
          acceptedByUserId: schema.familyInvites.acceptedByUserId,
        })
        .from(schema.familyInvites)
        .where(eq(schema.familyInvites.token, token))
        .limit(1);
      return rows[0] ?? null;
    },

    async addMember(args) {
      await database
        .insert(schema.familyMembers)
        .values({
          familyId: args.familyId,
          userId: args.userId,
          role: args.role,
          invitedByUserId: args.invitedByUserId,
        })
        .onConflictDoNothing();
    },

    async markAccepted(args) {
      await database
        .update(schema.familyInvites)
        .set({ acceptedAt: args.now, acceptedByUserId: args.userId })
        .where(eq(schema.familyInvites.id, args.inviteId));
    },
  };
}
