import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { matchPhrase, normalizeReply } from '~/lib/channel/affirmative';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import {
  type DiscoverabilityConsentInput,
  recordDiscoverabilityConsent,
  recordProposalConsent,
} from './consent';
import {
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_NO_ACK,
  INTRO_YES_ACK,
  NO_OPEN_INTRO,
} from './copy';

/**
 * Village intros v1 — the inbound half. A parent's word, read deterministically.
 *
 * NO MODEL, EVER, on this path. Two of these four keywords are consent (rule #4) and
 * one is a REVOCATION, and a revocation a model might paraphrase is not a revocation.
 * It sits in the router's deterministic layer for the same reason "YES 2" does: the
 * only way to guarantee the model never mis-reads a word is for the model never to see
 * it.
 *
 * WHY TWO-WORD KEYWORDS. A bare "yes" belongs to whatever Hale last asked, and Hale
 * asks about several things. INTRO / INTROS says which question is being answered, so
 * the intro loop can run alongside an open approval without either lane stealing the
 * other's answers. The approval grammar declines these strings for free — they are not
 * bare affirmatives — which the router tests assert from the other side.
 *
 * WHY THE HANDLER ONLY WRITES. A reply moves the proposal's STATE; the sweep performs
 * the EFFECTS (the intro email, the other side's soft close). Splitting them that way
 * is what makes the loop crash-safe: a text that lands and then dies mid-send leaves a
 * recorded decision the next sweep converges on, never a decision recorded twice or an
 * email sent for a pair whose row never committed.
 */

/** Which question a keyword answers, and what the answer was. */
export interface IntroKeyword {
  target: 'discoverability' | 'proposal';
  granted: boolean;
}

/** Heads that mean "no" here but are not in the shared NEGATIVE vocabulary. 'stop'
 * scoped to a noun is a parent narrowing their refusal, not a CASL unsubscribe — bare
 * STOP is claimed by {@link matchKeyword} long before this lane sees it. */
const EXTRA_REFUSAL_HEADS: ReadonlySet<string> = new Set(['stop']);

/**
 * The intro keyword this body IS, or null when it is anything else.
 *
 * Read as HEAD + NOUN rather than against a list of four literals: parents type "yeah
 * intros" and "nope intro", and every variant missing from a literal list is a decision
 * silently dropped (the VIL-260 lesson). The head goes through the shared affirmative
 * vocabulary, so widening that widens this at the same time.
 */
export function matchIntroKeyword(body: string): IntroKeyword | null {
  // A carrier keyword was already answered upstream; a second reading of it here could
  // only ever disagree with the first.
  if (matchKeyword(body)) return null;

  const words = normalizeReply(body).split(' ').filter(Boolean);
  if (words.length !== 2) return null;

  const [head, noun] = words as [string, string];
  if (noun !== 'intro' && noun !== 'intros') return null;

  const target = noun === 'intros' ? 'discoverability' : 'proposal';
  const affirmation = matchPhrase(head);
  if (affirmation === 'yes') return { target, granted: true };
  if (affirmation === 'no' || EXTRA_REFUSAL_HEADS.has(head)) return { target, granted: false };
  return null;
}

export type IntroReplyOutcome =
  | { status: 'declined_to_claim' }
  | { status: 'discoverability_granted'; reply: string }
  | { status: 'discoverability_revoked'; reply: string }
  | { status: 'intro_accepted'; reply: string }
  | { status: 'intro_declined'; reply: string }
  | { status: 'no_open_intro'; reply: string };

export interface IntroReplyInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
}

/** The subset of a proposal a reply needs: which side is answering, and whether the
 * other side has already answered. */
export interface OpenIntroProposal {
  id: string;
  familyAId: string;
  familyBId: string;
  familyAReply: 'yes' | 'no' | null;
  familyBReply: 'yes' | 'no' | null;
}

export interface IntroDecision {
  proposalId: string;
  familyId: string;
  parentUserId: string;
  /** Which side of the pair this family is. Resolved by the caller so the writer does
   * not have to re-decide it from ids. */
  side: 'a' | 'b';
  granted: boolean;
  /** True only when THIS reply is the one that completes the pair. */
  bothAccepted: boolean;
  verbatimReply: string;
  now: Date;
}

export interface VillageIntroReplyDeps {
  recordDiscoverability(database: Database, input: DiscoverabilityConsentInput): Promise<void>;
  /** The proposal this family may answer right now, or null. */
  openProposal(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<OpenIntroProposal | null>;
  /** The proposal row, the consent row and the audit row, in ONE transaction. */
  recordDecision(database: Database, decision: IntroDecision): Promise<void>;
  /** Close every live proposal this family is named in (a revocation). */
  cancelOpenProposals(database: Database, familyId: string, now: Date): Promise<void>;
}

/**
 * Answer one intro keyword.
 *
 * A REVOCATION CANCELS OPEN PROPOSALS, and it does so right after the consent row. Those
 * two facts must never drift apart: a family whose consent says "not discoverable"
 * while a live proposal still names them is exactly the state where the next sweep
 * texts a card about somebody who switched this off.
 */
export async function handleVillageIntroReply(
  database: Database,
  input: IntroReplyInput,
  deps: VillageIntroReplyDeps,
): Promise<IntroReplyOutcome> {
  const keyword = matchIntroKeyword(input.body);
  if (!keyword) return { status: 'declined_to_claim' };

  if (keyword.target === 'discoverability') {
    await deps.recordDiscoverability(database, {
      familyId: input.familyId,
      userId: input.parentUserId,
      granted: keyword.granted,
      verbatimReply: input.body,
      // The router hands a handler the TURN, not the ledger row it arrived on, so this
      // is genuinely unavailable here rather than omitted. The verbatim reply above is
      // the evidence; the null names what is missing instead of implying a row.
      channelMessageId: null,
    });
    if (keyword.granted) {
      return { status: 'discoverability_granted', reply: DISCOVERABILITY_ON };
    }
    await deps.cancelOpenProposals(database, input.familyId, input.now);
    return { status: 'discoverability_revoked', reply: DISCOVERABILITY_OFF };
  }

  const proposal = await deps.openProposal(database, input.familyId, input.now);
  if (!proposal) return { status: 'no_open_intro', reply: NO_OPEN_INTRO };

  const side = proposal.familyAId === input.familyId ? 'a' : 'b';
  const otherReply = side === 'a' ? proposal.familyBReply : proposal.familyAReply;

  await deps.recordDecision(database, {
    proposalId: proposal.id,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    side,
    granted: keyword.granted,
    bothAccepted: keyword.granted && otherReply === 'yes',
    verbatimReply: input.body,
    now: input.now,
  });

  return keyword.granted
    ? { status: 'intro_accepted', reply: INTRO_YES_ACK }
    : { status: 'intro_declined', reply: INTRO_NO_ACK };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The proposal a family may answer: still open, still inside its window, and one this
 * side has actually been ASKED about. A card that was never sent cannot be answered,
 * and treating an unsent card as answerable would let a parent accept an introduction
 * they were never offered.
 */
async function loadOpenProposal(
  database: Database,
  familyId: string,
  now: Date,
): Promise<OpenIntroProposal | null> {
  const [row] = await database
    .select({
      id: schema.villageIntroProposals.id,
      familyAId: schema.villageIntroProposals.familyAId,
      familyBId: schema.villageIntroProposals.familyBId,
      familyAReply: schema.villageIntroProposals.familyAReply,
      familyBReply: schema.villageIntroProposals.familyBReply,
    })
    .from(schema.villageIntroProposals)
    .where(
      and(
        eq(schema.villageIntroProposals.status, 'proposed'),
        isNull(schema.villageIntroProposals.closedAt),
        gt(schema.villageIntroProposals.expiresAt, now),
        or(
          and(
            eq(schema.villageIntroProposals.familyAId, familyId),
            isNotNull(schema.villageIntroProposals.familyAAskedAt),
            isNull(schema.villageIntroProposals.familyAReply),
          ),
          and(
            eq(schema.villageIntroProposals.familyBId, familyId),
            isNotNull(schema.villageIntroProposals.familyBAskedAt),
            isNull(schema.villageIntroProposals.familyBReply),
          ),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function writeDecision(database: Database, decision: IntroDecision): Promise<void> {
  const answer = decision.granted ? 'yes' : 'no';
  await database.transaction(async (tx) => {
    await tx
      .update(schema.villageIntroProposals)
      .set({
        ...(decision.side === 'a'
          ? { familyAReply: answer, familyARepliedAt: decision.now }
          : { familyBReply: answer, familyBRepliedAt: decision.now }),
        // A 'no' ends the pairing outright. A 'yes' only ends the WAITING once the other
        // side has also said yes; the sweep is what turns `both_accepted` into an actual
        // introduction, and stamps closed_at when it has.
        status: decision.granted ? (decision.bothAccepted ? 'both_accepted' : 'proposed') : 'declined',
        updatedAt: decision.now,
      })
      .where(eq(schema.villageIntroProposals.id, decision.proposalId));

    await recordProposalConsent(tx as unknown as Database, {
      familyId: decision.familyId,
      userId: decision.parentUserId,
      proposalId: decision.proposalId,
      granted: decision.granted,
      verbatimReply: decision.verbatimReply,
      channelMessageId: null,
      question: 'village intro card',
    });

    await tx.insert(schema.auditLog).values({
      familyId: decision.familyId,
      actor: decision.parentUserId,
      actionTaken: decision.granted ? 'village_intro_accepted' : 'village_intro_declined',
      targetTable: 'village_intro_proposals',
      targetId: decision.proposalId,
      after: { proposalId: decision.proposalId, bothAccepted: decision.bothAccepted },
    });
  });
}

/**
 * A revocation closes every live pairing this family is in.
 *
 * `closed_at` is deliberately LEFT NULL: the other side was asked a question and is
 * owed an answer, and the sweep is what sends it. Stamping closed here would make the
 * pairing vanish from the sweep's view with one parent still waiting on a reply.
 */
async function cancelOpenProposalsFor(
  database: Database,
  familyId: string,
  now: Date,
): Promise<void> {
  await database
    .update(schema.villageIntroProposals)
    .set({ status: 'declined', updatedAt: now })
    .where(
      and(
        isNull(schema.villageIntroProposals.closedAt),
        or(
          eq(schema.villageIntroProposals.familyAId, familyId),
          eq(schema.villageIntroProposals.familyBId, familyId),
        ),
      ),
    );
}

export function defaultVillageIntroReplyDeps(): VillageIntroReplyDeps {
  return {
    recordDiscoverability: recordDiscoverabilityConsent,
    openProposal: loadOpenProposal,
    recordDecision: writeDecision,
    cancelOpenProposals: cancelOpenProposalsFor,
  };
}
