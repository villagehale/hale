import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';

/**
 * Village intros v1 — the consent ledger for being introduced.
 *
 * TWO SCOPES, ONE TYPE, because they are two different permissions and collapsing them
 * would make the second unaskable:
 *
 *   · {@link DISCOVERABILITY_SCOPE} — the standing "you may look for a match for us".
 *     Revocable at any moment (NO INTROS), and read before a family is ever considered
 *     by the matcher.
 *   · {@link proposalScope} — "yes, introduce us to THIS one". Per proposal, because a
 *     family that wants intros in general has still not agreed to any particular one.
 *
 * LATEST ROW WINS, and that rule is not optional here. `consent_records` carries BOTH
 * withdrawal conventions in production — a `revoked_at` stamp on the granting row, and
 * an appended `granted=false` row — so a naive `granted = true` existence check reads
 * "yes" for a family that switched intros off an hour ago. This module is the only
 * reader, so the rule lives in exactly one place (the outbound gate's `readWatchConsent`
 * is the same shape for the same reason).
 */

export const DISCOVERABILITY_SCOPE = 'village_intro:discoverability';

/** The scope string for one specific proposal's yes/no. Carrying the proposal id makes
 * the record answer "which introduction did they agree to", which a scope of
 * 'village_intro' alone could never do. */
export function proposalScope(proposalId: string): string {
  return `village_intro:proposal:${proposalId}`;
}

/**
 * How an answer was READ, recorded beside what it said.
 *
 * D17 makes natural language consent, and this is the half that makes that auditable
 * rather than asserted (rule #6): a keyword proves a parent typed the token Hale taught
 * them, while a resolved sentence is stronger evidence of intent and weaker evidence of
 * mechanism. Months later, a family disputing an introduction is owed an answer to "did
 * somebody type a word, or did a model read a sentence, and how sure was it" — and there
 * is nowhere else in the row that answer could live.
 *
 * A JSONB addition to a column that already exists, so no migration.
 */
export interface ConsentReading {
  readBy: 'keyword' | 'reply-resolver';
  /** Null for a keyword — a typed token has no confidence, it either matched or it did
   * not. Never folded into a default (rule #11): the absence means something. */
  confidence: 'high' | 'medium' | 'low' | null;
}

export interface DiscoverabilityConsentInput {
  familyId: string;
  userId: string;
  granted: boolean;
  /** The parent's own words. Verbatim — the consent's legal instrument (D17). */
  verbatimReply: string;
  /** The channel_messages row the reply arrived on, so the record points at the
   * message rather than at a second copy of its text. */
  channelMessageId: string | null;
  reading: ConsentReading;
}

/**
 * Record a family's standing answer to the discoverability ask.
 *
 * A DECLINE WRITES A ROW TOO. "No" is a fact about this family that the matcher has to
 * be able to read, and an absent row is indistinguishable from "never asked" — which
 * is exactly the state that would make Hale ask again.
 *
 * The consent row and its audit row go in one transaction so a crash can never leave a
 * family discoverable with no record of them agreeing to it (rule #6).
 */
export async function recordDiscoverabilityConsent(
  database: Database,
  input: DiscoverabilityConsentInput,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.insert(schema.consentRecords).values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'village_intro',
      granted: input.granted,
      consentScope: DISCOVERABILITY_SCOPE,
      policyVersion: POLICY_VERSION,
      evidence: {
        // HOW THIS ANSWER WAS READ — a typed keyword, or a sentence the natural-reply
        // stage interpreted, and how sure it was. D17 says natural language IS consent;
        // that is only auditable if the row says which mechanism produced it (rule #6).
        ...input.reading,
        // A STABLE DESCRIPTION, not the sentence that was sent. The ask is composed per
        // send now (voice.ts), so there is no one sentence to quote — and quoting one
        // attempt's wording as though it were the question would be worse evidence than
        // naming the question. What carries the weight under D17 is unchanged and is all
        // below: the parent's own words, what Hale took them to mean, and the message id.
        // The proposal side has recorded its question this way since it shipped.
        question: 'village intro discoverability ask',
        verbatimReply: input.verbatimReply,
        interpretation: input.granted
          ? 'parent opted in to being introduced to other Hale families nearby'
          : 'parent opted out of being introduced to other Hale families',
        channelMessageId: input.channelMessageId,
      },
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: input.granted
        ? 'village_intro_discoverability_granted'
        : 'village_intro_discoverability_revoked',
      targetTable: 'consent_records',
      targetId: input.familyId,
      after: { scope: DISCOVERABILITY_SCOPE, granted: input.granted },
    });
  });
}

export interface ProposalConsentInput {
  familyId: string;
  userId: string;
  proposalId: string;
  granted: boolean;
  verbatimReply: string;
  channelMessageId: string | null;
  /** The exact card this parent was answering. Stored as the `question` so the record
   * carries both halves of the exchange, not just their half. */
  question: string;
  reading: ConsentReading;
}

/** Record one side's answer to one coarse card. Written by the reply handler inside the
 * same transaction that stamps the proposal, so the row and the state can never
 * disagree about what a family said. */
export async function recordProposalConsent(
  tx: Database,
  input: ProposalConsentInput,
): Promise<void> {
  await tx.insert(schema.consentRecords).values({
    userId: input.userId,
    familyId: input.familyId,
    consentType: 'village_intro',
    granted: input.granted,
    consentScope: proposalScope(input.proposalId),
    policyVersion: POLICY_VERSION,
    evidence: {
      ...input.reading,
      question: input.question,
      verbatimReply: input.verbatimReply,
      interpretation: input.granted
        ? 'parent agreed to be introduced to the matched family'
        : 'parent declined the introduction',
      channelMessageId: input.channelMessageId,
    },
  });
}

/**
 * Is this parent discoverable RIGHT NOW?
 *
 * The newest row wins, and it only counts as a grant when it is a grant that was never
 * revoked. Both withdrawal conventions are handled by that one rule.
 */
export async function discoverabilityGranted(
  database: Database,
  userId: string,
): Promise<boolean> {
  const [latest] = await database
    .select({
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentType, 'village_intro'),
        eq(schema.consentRecords.consentScope, DISCOVERABILITY_SCOPE),
      ),
    )
    .orderBy(desc(schema.consentRecords.grantedAt))
    .limit(1);
  return latest?.granted === true && latest.revokedAt === null;
}

/**
 * Has this parent ever been ASKED? Distinct from having answered: a family that was
 * asked and ignored it must not be asked again, and the send ledger alone cannot say so
 * once its rows age out of any window.
 *
 * Any row on this scope — grant or decline — is proof the question was put.
 */
export async function discoverabilityAsked(
  database: Database,
  userId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentType, 'village_intro'),
        eq(schema.consentRecords.consentScope, DISCOVERABILITY_SCOPE),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The batched form the matcher uses: which of these parents are discoverable now.
 *
 * One query, latest-row-wins applied per user in memory. The rows come back newest
 * first, so the FIRST row seen for a user is that user's current answer and every later
 * row for them is history — which is what makes a revocation win over the grant it
 * superseded without a per-user round trip.
 */
export async function discoverableUserIds(
  database: Database,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await database
    .select({
      userId: schema.consentRecords.userId,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        inArray(schema.consentRecords.userId, [...userIds]),
        eq(schema.consentRecords.consentType, 'village_intro'),
        eq(schema.consentRecords.consentScope, DISCOVERABILITY_SCOPE),
      ),
    )
    .orderBy(desc(schema.consentRecords.grantedAt));

  const decided = new Set<string>();
  const granted = new Set<string>();
  for (const row of rows) {
    if (decided.has(row.userId)) continue;
    decided.add(row.userId);
    if (row.granted && row.revokedAt === null) granted.add(row.userId);
  }
  return granted;
}
