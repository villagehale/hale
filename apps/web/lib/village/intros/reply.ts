import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { matchPhrase, normalizeReply } from '~/lib/channel/affirmative';
import { introScope, villageIntrosAllowlist } from './run';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import {
  type ConsentReading,
  type DiscoverabilityConsentInput,
  discoverabilityAsked,
  discoverabilityGranted,
  recordDiscoverabilityConsent,
  recordProposalConsent,
} from './consent';
import {
  DISCOVERABILITY_ALREADY_OFF,
  DISCOVERABILITY_ALREADY_ON,
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_ALREADY_NO,
  INTRO_ALREADY_YES,
  INTRO_CLOSED_AFTER_NO,
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

/**
 * What a parent has already said about being discoverable.
 *
 * A TRI-STATE, and it has to be: `unanswered` and `declined` are the same boolean and
 * completely different facts. A decline WRITES A ROW — the matcher reads it, and an absent
 * row is indistinguishable from never having been asked, which is the state that makes
 * Hale ask again. Collapsing the two would mean a family's first "no intros" was answered
 * with "already off" and never recorded, and they would be asked a second time.
 */
export type IntroStanding = 'granted' | 'declined' | 'unanswered';

/**
 * IS THIS THE ANSWER THEY ALREADY GAVE? — the one rule, for both questions.
 *
 * Two instances of one defect (founder's live test, 2026-08-13): a repeated "Yes intros"
 * wrote a second consent row and repeated the whole acknowledgement, and a repeated
 * "YES INTRO" was told there was no intro waiting seconds after being told one was
 * coming. Both read as Hale forgetting a conversation it is currently having. After two
 * instances of a shape the fix is to make the shape unexpressible, so there is one
 * function and both branches call it — the rule cannot be right for the opt-in and wrong
 * for the card.
 *
 * ONLY A MATCH IS A REPEAT, and that is the whole safety property. A "no" after a "yes"
 * is a change of mind and must always be honoured; a repeat that swallowed one would be a
 * withdrawal Hale ignored. `unanswered` is never a repeat either — a first refusal has to
 * be recorded or the matcher cannot see it and the family gets asked again.
 */
export function repeatedAnswer(standing: IntroStanding, granted: boolean): boolean {
  return standing === (granted ? 'granted' : 'declined');
}

/**
 * WHICH SIDE AM I, AND WHAT DID I SAY — the other half of the primitive, pulled out of the
 * query for the same reason {@link introStanding} was.
 *
 * A pairing has two sides and one row, so reading a family's own answer means picking the
 * right column first. Getting that backwards would report family A's answer to family B —
 * which is both a wrong receipt and a cross-household read — and no test that injects a
 * ready-made `standing` can see it. This is a pure function precisely so one can.
 */
export function proposalStanding(
  proposal: {
    familyAId: string;
    familyAReply: 'yes' | 'no' | null;
    familyBReply: 'yes' | 'no' | null;
  },
  familyId: string,
): IntroStanding {
  const mine = proposal.familyAId === familyId ? proposal.familyAReply : proposal.familyBReply;
  return introStanding({ answered: mine !== null, granted: mine === 'yes' });
}

/**
 * The two consent facts, resolved into one standing answer.
 *
 * A PURE FUNCTION, separated from the two queries above it deliberately. The queries are
 * wiring and are covered by the journey; the DECISION is the part that can be silently
 * wrong, and folding `unanswered` into `declined` is a change no fake-injected test can
 * see — the handler tests stub this reader, so they keep passing while the real one starts
 * swallowing every family's first refusal.
 */
export function introStanding(facts: { answered: boolean; granted: boolean }): IntroStanding {
  if (!facts.answered) return 'unanswered';
  return facts.granted ? 'granted' : 'declined';
}

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
  /** They said again what they already said. Answered briefly, nothing written. */
  | { status: 'discoverability_unchanged'; reply: string }
  | { status: 'intro_accepted'; reply: string }
  | { status: 'intro_declined'; reply: string }
  /** They said again what they already said about this card. Nothing written. */
  | { status: 'intro_unchanged'; reply: string }
  /** A yes after their own no. The pairing is over and is not reopened. */
  | { status: 'intro_closed'; reply: string }
  | { status: 'no_open_intro'; reply: string };

export interface IntroReplyInput {
  familyId: string;
  parentUserId: string;
  body: string;
  now: Date;
  /**
   * A decision the router's natural-reply stage already made about THIS message
   * (lib/channel/router/resolve.ts), when the parent answered in their own words rather
   * than in one of the four keywords.
   *
   * The keyword read still runs first and still wins — `null` is the ordinary case and
   * the behaviour is byte-for-byte what it was. What this does NOT change is the
   * evidence: `input.body` is still what lands in the consent ledger, so what is recorded
   * is the sentence the parent actually sent and not a keyword Hale reverse-engineered.
   * Under D17 that is the stronger record, because a keyword only ever proves somebody
   * typed the token they were taught.
   */
  resolved?: ResolvedIntroAnswer | null;
}

/** A keyword the router's natural-reply stage inferred rather than read, and how sure it
 * was. The confidence rides all the way to the consent row (see below). */
export interface ResolvedIntroAnswer extends IntroKeyword {
  confidence: 'high' | 'medium' | 'low';
}

/** The subset of a proposal a reply needs: which side is answering, and whether the
 * other side has already answered. */
export interface AnswerableProposal {
  id: string;
  familyAId: string;
  familyBId: string;
  familyAReply: 'yes' | 'no' | null;
  familyBReply: 'yes' | 'no' | null;
  /** What THIS family has already said about this card. Resolved by the reader so the
   * handler does not have to work out which side it is looking at twice. */
  standing: IntroStanding;
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
  reading: ConsentReading;
  now: Date;
}

export interface VillageIntroReplyDeps {
  recordDiscoverability(database: Database, input: DiscoverabilityConsentInput): Promise<void>;
  /** What this parent has ALREADY said about being discoverable. Read before writing, so
   * a repeated answer is recognised as the repeat it is. */
  discoverabilityStanding(database: Database, parentUserId: string): Promise<IntroStanding>;
  /**
   * The live card this family was ASKED about — answered or not — or null.
   *
   * It used to require `reply IS NULL`, which made an already-answered side invisible and
   * is what produced both halves of the 2026-08-13 defect: a repeat could not be told from
   * a card that never existed, and a WITHDRAWAL could not be told from either. The
   * handler needs to see the answer to know which of those it is looking at.
   */
  answerableProposal(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<AnswerableProposal | null>;
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
  const typed = matchIntroKeyword(input.body);
  const keyword = typed ?? input.resolved ?? null;
  if (!keyword) return { status: 'declined_to_claim' };
  // HOW THIS YES WAS READ, recorded with it. A keyword proves a parent typed the token
  // Hale taught them; a resolved sentence proves more about what they meant and less about
  // the mechanism, so the mechanism has to be in the row (rule #6).
  const reading: ConsentReading =
    typed !== null
      ? { readBy: 'keyword', confidence: null }
      : { readBy: 'reply-resolver', confidence: input.resolved?.confidence ?? null };

  if (keyword.target === 'discoverability') {
    // ALREADY THEIR ANSWER? Then this is a repeat, not a decision (see
    // DISCOVERABILITY_ALREADY_ON). Compared against the STANDING answer rather than
    // against a recency window, because what makes it a repeat is that nothing would
    // change — a parent re-confirming a month later is just as much not-a-new-decision.
    //
    // Only when the answers MATCH. A "no intros" after a yes is a revocation and is always
    // honoured; a revocation that gets deduplicated is not a revocation.
    const standing = await deps.discoverabilityStanding(database, input.parentUserId);
    if (repeatedAnswer(standing, keyword.granted)) {
      return {
        status: 'discoverability_unchanged',
        reply: keyword.granted ? DISCOVERABILITY_ALREADY_ON : DISCOVERABILITY_ALREADY_OFF,
      };
    }

    await deps.recordDiscoverability(database, {
      familyId: input.familyId,
      userId: input.parentUserId,
      granted: keyword.granted,
      verbatimReply: input.body,
      // The router hands a handler the TURN, not the ledger row it arrived on, so this
      // is genuinely unavailable here rather than omitted. The verbatim reply above is
      // the evidence; the null names what is missing instead of implying a row.
      channelMessageId: null,
      reading,
    });
    if (keyword.granted) {
      return { status: 'discoverability_granted', reply: DISCOVERABILITY_ON };
    }
    await deps.cancelOpenProposals(database, input.familyId, input.now);
    return { status: 'discoverability_revoked', reply: DISCOVERABILITY_OFF };
  }

  const proposal = await deps.answerableProposal(database, input.familyId, input.now);
  if (!proposal) return { status: 'no_open_intro', reply: NO_OPEN_INTRO };

  // THE SAME RULE AS THE OPT-IN, one function up. A repeat is answered and not rewritten.
  if (repeatedAnswer(proposal.standing, keyword.granted)) {
    return {
      status: 'intro_unchanged',
      reply: keyword.granted ? INTRO_ALREADY_YES : INTRO_ALREADY_NO,
    };
  }
  // A yes after their own no. Not a repeat, and not something to act on either: the other
  // family has had their soft close by now, and an introduction they were told was not
  // happening cannot be un-told. Recording it would resurrect a dead pairing.
  if (proposal.standing === 'declined') {
    return { status: 'intro_closed', reply: INTRO_CLOSED_AFTER_NO };
  }

  // Everything left is a real decision: a first answer, or a WITHDRAWAL after a yes. The
  // withdrawal is the one this widened read exists for — it used to be invisible, so a
  // parent changing their mind before the disclosure was ignored and the email still went.
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
    reading,
    now: input.now,
  });

  return keyword.granted
    ? { status: 'intro_accepted', reply: INTRO_YES_ACK }
    : { status: 'intro_declined', reply: INTRO_NO_ACK };
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The two consent reads that make up one standing answer.
 *
 * `discoverabilityAsked` is "is there a row at all" and `discoverabilityGranted` is
 * latest-row-wins over both withdrawal conventions. Neither alone can tell a decline from
 * a silence, and telling those apart is the whole point (see {@link IntroStanding}).
 */
async function readDiscoverabilityStanding(
  database: Database,
  parentUserId: string,
): Promise<IntroStanding> {
  const [answered, granted] = await Promise.all([
    discoverabilityAsked(database, parentUserId),
    discoverabilityGranted(database, parentUserId),
  ]);
  return introStanding({ answered, granted });
}

/**
 * The proposal a family may answer: still open, still inside its window, and one this
 * side has actually been ASKED about. A card that was never sent cannot be answered,
 * and treating an unsent card as answerable would let a parent accept an introduction
 * they were never offered.
 */
async function loadAnswerableProposal(
  database: Database,
  familyId: string,
  now: Date,
): Promise<AnswerableProposal | null> {
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
        // LIVE and not yet resolved into an outcome. `closed_at` is the line: once the
        // sweep has sent the introduction or the soft close, there is nothing left to
        // answer and nothing left to withdraw.
        isNull(schema.villageIntroProposals.closedAt),
        gt(schema.villageIntroProposals.expiresAt, now),
        // NO `reply IS NULL` and no `status = 'proposed'`. Both used to be here, and
        // together they hid exactly the two rows this handler most needs to see: a side
        // that already answered (a repeat) and a pair that both-accepted (a withdrawal
        // arriving before the email). `asked_at` stays — a card that was never sent
        // cannot be answered, which is the one filter that was always right.
        or(
          and(
            eq(schema.villageIntroProposals.familyAId, familyId),
            isNotNull(schema.villageIntroProposals.familyAAskedAt),
          ),
          and(
            eq(schema.villageIntroProposals.familyBId, familyId),
            isNotNull(schema.villageIntroProposals.familyBAskedAt),
          ),
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, standing: proposalStanding(row, familyId) };
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
      reading: decision.reading,
    });

    await tx.insert(schema.auditLog).values({
      familyId: decision.familyId,
      actor: decision.parentUserId,
      actionTaken: decision.granted ? 'village_intro_accepted' : 'village_intro_declined',
      targetTable: 'village_intro_proposals',
      targetId: decision.proposalId,
      after: {
        proposalId: decision.proposalId,
        bothAccepted: decision.bothAccepted,
        ...decision.reading,
      },
    });
  });
}

/**
 * A revocation closes every live pairing this family is in.
 *
 * IT ALSO STAMPS THE REVOKER'S OWN SIDE AS 'no'. That is not bookkeeping tidiness: the
 * sweep decides who is owed a soft close by asking "which asked side did not itself say
 * no", and a revoker whose side stayed null would be texted "no intro this time"
 * seconds after being told "done, no intros" — Hale answering its own message.
 *
 * `closed_at` is deliberately LEFT NULL: the OTHER side was asked a question and is
 * owed an answer, and the sweep is what sends it. Stamping closed here would make the
 * pairing vanish from the sweep's view with one parent still waiting on a reply.
 */
async function cancelOpenProposalsFor(
  database: Database,
  familyId: string,
  now: Date,
): Promise<void> {
  const open = isNull(schema.villageIntroProposals.closedAt);
  await database
    .update(schema.villageIntroProposals)
    .set({ status: 'declined', familyAReply: 'no', familyARepliedAt: now, updatedAt: now })
    .where(and(open, eq(schema.villageIntroProposals.familyAId, familyId)));
  await database
    .update(schema.villageIntroProposals)
    .set({ status: 'declined', familyBReply: 'no', familyBRepliedAt: now, updatedAt: now })
    .where(and(open, eq(schema.villageIntroProposals.familyBId, familyId)));
}

export function defaultVillageIntroReplyDeps(): VillageIntroReplyDeps {
  return {
    recordDiscoverability: recordDiscoverabilityConsent,
    discoverabilityStanding: readDiscoverabilityStanding,
    /**
     * THE ALLOWLIST GATES THE ANSWER TOO, not just the sweep.
     *
     * A pairing minted while the flag was wide open outlives the narrowing, and a card
     * that was already sent can still be replied to. Without this, an unlisted family
     * could still drive that proposal to `both_accepted` — a consent row, an audit row and
     * a state change for a household the rail is supposed to have stepped away from. It
     * gates only the QUESTION: a revocation is answered whatever the scope says, because a
     * family withdrawing consent is never something a flag may refuse.
     */
    answerableProposal: async (database, familyId, now) =>
      introScope(villageIntrosAllowlist())(familyId)
        ? loadAnswerableProposal(database, familyId, now)
        : null,
    recordDecision: writeDecision,
    cancelOpenProposals: cancelOpenProposalsFor,
  };
}
