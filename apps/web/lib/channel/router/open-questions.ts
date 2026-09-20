import type { Database } from '@hale/db';
import { actionTypeLabel } from '~/lib/format/labels';
// Type-only, so the cycle with approval.ts (which imports `approvalSubjects` from here)
// is erased at build time. One shape for a drafted action, owned by the spine that reads
// them, rather than a structural copy the two files could drift apart on.
import type { PendingAction } from './approval';
import { MAX_LISTED_APPROVALS } from './fast-path';

/**
 * WHAT HALE IS CURRENTLY WAITING TO HEAR BACK ABOUT — every open question, derived.
 *
 * THERE IS NO REGISTRY TABLE AND THERE MUST NOT BE ONE. Every question below is already
 * implied by state some module owns: a drafted action IS the approval question, an
 * un-answered proposal row IS the intro question, an open `plan_offer` commitment IS the
 * plan question. A second table listing them would be a second answer to "is this still
 * open", and the two would disagree the first time a co-parent answered something in the
 * app. So this module OWNS NO STATE; it asks the modules that do and puts their answers
 * in one shape.
 *
 * WHY IT EXISTS AT ALL. A parent who is handed a keyword can be understood by a string
 * comparison. A parent who is allowed to answer in their own words can only be understood
 * against the questions actually outstanding — "yeah go ahead" means nothing in the
 * abstract and means one specific thing when exactly one thing is pending. This list is
 * what makes that reading possible, and it is also the cost control: no open question, no
 * model call (see resolve.ts).
 *
 * WHAT MAY BE IN A DESCRIPTION (rule #1). Only what HALE ITSELF put in the message it
 * sent — an action TYPE label, never a payload; the fact that an introduction is pending,
 * never who with. The descriptions go to a model, so the rule is the strictest reading:
 * nothing about another household, and nothing about this one that Hale did not already
 * text them.
 */

/**
 * The questions a parent can answer YES or NO to.
 *
 * Deliberately NOT every open thread Hale has. Three are missing and all for one reason:
 * their answer is not a polarity, so a stage that returns yes/no could only mis-answer
 * them.
 *
 *   · The IDENTITY gap-fills want a value — "yes" is not an email address. They keep their
 *     own shape-matching handlers, which read an address or a name from any wording at all
 *     and never needed a model.
 *   · The REGISTRATION check-in wants one of three outcomes ("we got in", "waitlisted
 *     #3", "missed it"), and M7 already hands anything it cannot read to the coach.
 *   · The HEALTH checkpoint's DONE half is still missing, and for the original reason: the
 *     nudge asks two things at once ("Done, or want me to add booking it to your week?"),
 *     and "yes" to the first half is genuinely unreadable — filing a checkpoint as done
 *     writes a permanent suppression and the parent never hears about that errand again.
 *     The exact-word handler still reads "done", "did it", a tick — all free, all
 *     unchanged.
 *
 * Its OFFER half, though, is now here as `checkup_offer`, and removing it was the bug
 * (2026-08-20). "Want me to add booking it to your week?" is an offer with one polarity
 * and a real writer behind it, and a parent who accepted it had their acceptance read
 * against two unrelated standing questions instead. What made it listable is that the
 * nudge now WRITES THE OFFER DOWN at send time (lib/health/offer.ts) — the question is a
 * ledger row like every other one on this list, not a fact inferred from the last message
 * Hale happened to send.
 */
export type OpenQuestionKind =
  | 'approval'
  | 'intro_optin'
  | 'intro_proposal'
  | 'plan_offer'
  | 'checkup_offer'
  | 'activity_followup'
  /**
   * "A new family just joined from the Georgetown poster. Reply YES and I'll send them
   * your welcome note." — the founder's own offer, standing in his own thread
   * (lib/channel/founder/ping.ts). The only question on this list whose YES writes into a
   * DIFFERENT household than the one answering, which is why it is graded the way it is
   * below.
   */
  | 'founder_welcome_offer'
  /**
   * "Reply YES when that is done, or NO if not." — the registration ladder's readiness
   * checklist and the battle plan's single re-ask (VIL-338, registration/sequence/
   * copy.ts). The only question on this list whose openness is derived from the MESSAGE
   * LEDGER rather than from a row of its own: it is open while its ask is Hale's last
   * outbound word to that parent and closed the moment anything else goes out (see
   * `OpenQuestionSources.registrationReadiness`).
   */
  | 'registration_readiness'
  /**
   * "Reply YES and I'll text them once." — the parent authorising Hale to text the
   * number they named and seat that person as their co-parent (VIL-355, caregiver/
   * invites.ts). Its YES is the only one on this list that puts an unsolicited message
   * on a phone belonging to somebody who has never heard of Hale, which is why the
   * co-parent start now consults `soleOpenKind` before claiming a bare affirmative.
   */
  | 'co_parent_assent'
  /**
   * "Reply YES and it goes on your week." — the offer at the end of a Gmail alert
   * (lib/integrations/email-alert-offer.ts). Its YES writes a `family_events` row that
   * the reminder scheduler and the weekly plan both read, so the parent gets a text the
   * day before something they only ever saw in an email.
   *
   * IT IS THE ONE THAT WAS MISSING. The alert shipped that sentence once with nothing
   * behind it and #649 took it away, because a parent answering it reached the coach with
   * nothing drafted — or, with one unrelated action pending, APPROVED THAT ONE. This
   * member is the other half of putting the sentence back: the question is written down
   * at send time, on a row of its own, and a YES can only ever mean it.
   */
  | 'email_alert_add'
  /**
   * "How did today go with Mia and Leo?" — the evening check-in (VIL-353,
   * channel/checkin/reply.ts). The only question on this list whose answer is not a
   * polarity at all but a sentence, which is why it is unanswerable below and why its
   * own handler reads it. Like the readiness checklist, its openness is derived from the
   * MESSAGE LEDGER rather than a row: it stands while its ask is Hale's last word to
   * that parent, and lapses at 08:00 whatever happens.
   */
  | 'evening_check_in'
  /**
   * "Is Mia home with you during the week, or at daycare?" — the weekday-care ask
   * (VIL-360, channel/weekday-care). Listed for the reason `evening_check_in` is: its
   * answer is not a polarity at all, so nothing here can resolve it, and a bare "yes"
   * near it is AMBIGUOUS and must not be spent on an unrelated drafted action. Its
   * openness is derived from the MESSAGE LEDGER — it stands while its ask is Hale's
   * last word to that parent and lapses 48h later.
   */
  | 'weekday_care'
  /**
   * "How is Little Sprouts going?" — the daycare check-in (VIL-360,
   * channel/followup/question.ts). Listed for the reason `weekday_care` and
   * `evening_check_in` are: its answer is a sentence, not a polarity.
   *
   * IT IS ALSO THE ONE THAT WAS MISSING. `sendFollowup` writes a ledger row and threads
   * the message and registers NOTHING, so before this member a bare "yes" arriving
   * after "how is daycare going?" with one drafted action pending would have executed
   * that action.
   */
  | 'daycare_followup';

/**
 * How much certainty an answer to this class needs before it is acted on.
 *
 * `consequential` is D17's line drawn in code: a cross-household DISCLOSURE and a change
 * to a real calendar are the two answers whose wrong reading cannot be shrugged off, so
 * they need the resolver to be sure AND to have named which question it is sure about.
 * `ordinary` covers the answers whose wrong reading costs a message nobody wanted.
 */
export type QuestionGrade = 'consequential' | 'ordinary';

const GRADE: Record<OpenQuestionKind, QuestionGrade> = {
  // Executes something the parent cannot see and needs an undo.
  approval: 'consequential',
  // Discloses a household to another household.
  intro_proposal: 'consequential',
  // Turns discoverability on. Nothing is shared by it, and it is revocable in a sentence.
  intro_optin: 'ordinary',
  // Three texts of parenting advice.
  plan_offer: 'ordinary',
  // Drafts an appointment reminder and holds it for approval. Nothing is executed and
  // nothing is disclosed, so a wrong reading costs one draft the parent can decline.
  checkup_offer: 'ordinary',
  // Never reached — nothing resolves an activity promise (see KIND_ANSWERABLE). The
  // Record forces a choice anyway, and `ordinary` is the honest one: if a polarity ever
  // did get somewhere to go, the worst it could cost is one text nobody wanted.
  activity_followup: 'ordinary',
  // Texts a household that is NOT the one answering. Nothing is disclosed about them and
  // nothing is executed, but a wrong reading is still an unsolicited message to a stranger
  // sent in a person's name — the same class of cost as an introduction, so the same grade.
  founder_welcome_offer: 'consequential',
  // Records what the parent said about their own portal setup, on their own account.
  // Nothing is disclosed, nothing is executed, and every sentence downstream attributes
  // it back to them ('You told me ...'), so a wrong reading costs one clause that still
  // names its source. `ordinary` is also what lets a hedged "yeah I think so" be
  // recorded at medium confidence instead of costing a clarifying round trip on the
  // three days when the parent is actually doing the work.
  registration_readiness: 'ordinary',
  // Texts a number nobody has consented for, in the answering parent's name, and seats
  // whoever replies with the whole family surface. The same class of cost as an
  // introduction and then some — so the same grade.
  co_parent_assent: 'consequential',
  // Writes a real entry on the family's week and materializes reminders off it. Nothing
  // is executed and nothing is disclosed, but this Record's own line is "a change to a
  // real calendar" — the grade an approval carries for exactly this — and a wrong reading
  // costs a text the day before something that is not happening.
  email_alert_add: 'consequential',
  // Never reached — nothing resolves an evening check-in (see KIND_ANSWERABLE). The
  // Record forces a choice anyway, and `ordinary` is the honest one: a wrong reading
  // could at most cost one acknowledgment nobody wanted.
  evening_check_in: 'ordinary',
  // Never reached either (see KIND_ANSWERABLE): the answer is an either/or, not a
  // polarity. `ordinary` is the honest choice — the write it stands in front of is a
  // memory fact about this household's own week, disclosed to nobody.
  weekday_care: 'ordinary',
  // Never reached either: nothing resolves it. `ordinary` is the honest choice - the
  // answer is a sentence the coach reads, and nothing is written from a polarity.
  daycare_followup: 'ordinary',
};

export function questionGrade(kind: OpenQuestionKind): QuestionGrade {
  return GRADE[kind];
}

/** Polarities a question of this CLASS could have somewhere to put. A `no` to an offer
 * has no writer — the offer simply lapses — so a resolver-no there is not an answer this
 * system can record, and the turn goes to the coach, which can say something true. */
const KIND_ANSWERABLE: Record<OpenQuestionKind, Answerable> = {
  approval: { yes: true, no: true },
  intro_optin: { yes: true, no: true },
  intro_proposal: { yes: true, no: true },
  plan_offer: { yes: true, no: false },
  checkup_offer: { yes: true, no: false },
  // NEITHER POLARITY, and this is the one entry on the list that is not a question.
  //
  // An activity promise is Hale saying "I'll come back to you", which asks for nothing:
  // there is no yes that makes it more true and no no that has a writer, and the sweep
  // discharges it whatever the parent does. It is LISTED anyway, because the list is
  // what `soleOpenKind` reads to decide whether a bare "yes" is ambiguous — and on
  // 2026-08-20 a parent's "Yes, please", said while Hale was holding exactly this kind of
  // promise, was claimed by an unrelated flagged calendar draft and answered with a line
  // about Hale's own review. A promise Hale is holding makes a bare affirmative
  // ambiguous, whether or not it is the thing being answered, so the honest reading is to
  // list it and let the turn fall through to the coach — which is handed the subject and
  // can say something true about it.
  activity_followup: { yes: false, no: false },
  // BOTH polarities, unlike the two offers above, because both have a writer: a yes sends
  // the note, and a no VOIDS the offer with its own reason rather than leaving it to lapse
  // (lib/channel/founder/reply.ts). An offer whose no went nowhere would be one the
  // founder could only get rid of by ignoring it for two days.
  founder_welcome_offer: { yes: true, no: true },
  // BOTH polarities, because a NO is a FACT this feature records rather than an offer
  // lapsing: it writes `readiness_ready = false`, and the evening-before plan carries
  // "You have not told me the setup is done" because of it. A no-answerable readiness
  // question would drop the one answer the parent is most likely to have to give.
  registration_readiness: { yes: true, no: true },
  // BOTH polarities: the yes sends the one message, and the no CLOSES the invite with
  // its own terminal state rather than leaving it to lapse — a parent who changes their
  // mind about texting their partner should not have to wait 72 hours for it.
  co_parent_assent: { yes: true, no: true },
  // BOTH polarities, unlike the offers above: the no RESOLVES the offer as declined and
  // says so, rather than leaving it to lapse. A parent who says no to a school email they
  // are not interested in should not go on having it counted as a question Hale is
  // waiting on for the rest of the day.
  email_alert_add: { yes: true, no: true },
  // NEITHER POLARITY, the `activity_followup` reading for a different reason: the answer
  // to "how did today go" is a sentence, and a yes-or-no resolver could only ever
  // mis-read one. The keywords that DO move something (LESS, NO, DAILY) are read by the
  // handler as exact words, which needs no model. It is LISTED anyway, because the list
  // is what `soleOpenKind` reads: a question Hale is holding makes a bare affirmative
  // ambiguous whether or not it is the thing being answered.
  evening_check_in: { yes: false, no: false },
  // NEITHER POLARITY, and here it is the whole point rather than a consequence. The ask
  // is an EITHER/OR - "home with you during the week, or at daycare?" - so a bare "yes"
  // means nothing, and a resolver that bound one to this kind would be guessing at a
  // fact that changes what Hale offers a household for months. The words that DO settle
  // it are read by a deterministic grammar at a non-claiming gate, which needs no model.
  // It is LISTED so a bare affirmative near it is ambiguous for everything else.
  weekday_care: { yes: false, no: false },
  // NEITHER POLARITY, the `activity_followup` reading exactly: a check-in is Hale
  // asking how something went, which has no yes that makes it more true and no no with
  // a writer behind it. Listed so a bare affirmative near it is ambiguous - which is
  // the whole reason this member exists.
  daycare_followup: { yes: false, no: false },
};

export interface Answerable {
  yes: boolean;
  no: boolean;
}

/**
 * WHICH POLARITIES THIS PARTICULAR QUESTION CAN TAKE, RIGHT NOW.
 *
 * Per-question rather than per-class, and that is the second half of the 2026-08-20 fix.
 * A drafted action that has not cleared the reviewer (rule #3) is a real open question —
 * the parent can still say "drop it" — but its YES is refused by `approveDraftedAction`
 * whatever the parent says. Listing it as yes-answerable meant the resolver could bind an
 * acceptance to a row the mutator was always going to refuse, and the parent got a
 * sentence about Hale's internal review in place of an answer.
 *
 * So answerability is READ OFF THE ROW, at the one place the rows are read. A question
 * whose polarity has nowhere to go never resolves (resolve.ts returns `not_answerable`),
 * and the turn goes to the coach, which can say something true about it.
 */
export function answerable(question: OpenQuestion, polarity: 'yes' | 'no'): boolean {
  return question.answerable[polarity];
}

export interface OpenQuestion {
  /**
   * Stable, and stable across the two reads this turn makes of it: the row's own id where
   * a row exists (an action, a proposal, a commitment), and a derived key where the
   * question is the ABSENCE of a row. Never an ordinal — a position in a list can be
   * renumbered between the message and the answer, and an id cannot.
   */
  id: string;
  kind: OpenQuestionKind;
  /** One neutral line, from Hale's own ask — what the RESOLVER is shown. */
  description: string;
  /**
   * The same question as a short noun phrase, for the one sentence a PARENT may read
   * ("Which one - the swim class move, or meeting the family nearby?").
   *
   * A second field rather than a reused one because the two readers want opposite things.
   * A model reads better with a full line; a text message reads worse with one, and
   * splicing "A student vaccine record check is due on ICON." into a list of choices
   * produces a sentence no person would send. Both are Hale's own words either way.
   */
  subject: string;
  /** What answering it could actually DO, read off the row — see {@link answerable}. */
  answerable: Answerable;
  /**
   * When this ask was last put in front of the parent, off the owning row, or null where
   * no source threads it (an approval draft, the intro asks). Null is a fact, not a
   * default: it says recency CANNOT be established, which disables the newest-solicited
   * precedence for the whole list (see {@link newestSolicitedKind}).
   */
  askedAt: Date | null;
  /** True when this class's ask PRINTS an explicit keyword instruction ("Reply YES ...")
   * — see {@link SOLICITED}. */
  solicited: boolean;
}

/**
 * Which classes' asks print an explicit solicited keyword. The 2026-08-13 doctrine took
 * the printed keywords away from the composed asks, but two fixed sentences still carry
 * one — the founder ping ("Reply YES and I'll send them your welcome note", founder/
 * copy.ts) and the plan offer ("Want the full plan? Reply YES and I'll send it.",
 * channel/plan/offer.ts). A parent answering one of those with a bare YES is doing
 * exactly what the last message told them to do, and on 2026-08-28 (ads-week audit)
 * that YES fell to an older open question instead. Per CLASS, never per caller, the
 * same way the outbound gate types urgency — a solicited flag at a call site could not
 * widen this.
 */
const SOLICITED: Record<OpenQuestionKind, boolean> = {
  approval: false,
  intro_optin: false,
  intro_proposal: false,
  plan_offer: true,
  checkup_offer: false,
  activity_followup: false,
  founder_welcome_offer: true,
  // The readiness leg and the battle plan both print 'Reply YES when that is done, or
  // NO if not.' verbatim (registration/sequence/copy.ts).
  registration_readiness: true,
  // The scope question prints "Reply YES and I'll text them once." (coparent/copy.ts).
  co_parent_assent: true,
  // The alert prints "Reply YES and it goes on your week." verbatim, and it is the last
  // thing Hale said (integrations/email-alert.ts).
  email_alert_add: true,
  // FALSE, and the entry matters more here than anywhere else on this list. The FIRST ask
  // a family ever gets prints LESS and NO, but every ask after it prints nothing at all —
  // and this flag is per CLASS. Marking it solicited would hand `newestSolicitedKind` the
  // newest question in the product on most evenings, so a bare YES meant for an approval
  // draft would be claimed by a diary entry. None of the words this lane reads is an
  // affirmative anyway.
  evening_check_in: false,
  // The ask prints no keyword at all - it ends in a question mark, not an instruction.
  weekday_care: false,
  // The ask prints no keyword; the composer is forbidden a second sentence, let alone
  // an instruction.
  daycare_followup: false,
};

/**
 * The kind a bare affirmative binds to by RECENCY: the newest ask, when — and only when
 * — every open question's ask time is known, the top is not a tie, and that newest ask
 * is a solicited-keyword one. Everything else returns null and the 2026-08-13 rule
 * stands (nobody claims; the resolver reads or Hale asks in a sentence).
 *
 * The undated guard is deliberate, not a shortcut: an approval draft carries no ask
 * time here, and a bare YES near an open approval is exactly the coin flip the old
 * priority order resolved in favour of the expensive outcome. Recency that cannot be
 * established is not recency.
 */
export function newestSolicitedKind(
  questions: readonly OpenQuestion[],
): OpenQuestionKind | null {
  if (questions.length === 0) return null;
  if (questions.some((question) => question.askedAt === null)) return null;
  const byRecency = [...questions].sort(
    (a, b) => (b.askedAt as Date).getTime() - (a.askedAt as Date).getTime(),
  );
  const newest = byRecency[0] as OpenQuestion;
  const runnerUp = byRecency[1];
  if (runnerUp && (runnerUp.askedAt as Date).getTime() === (newest.askedAt as Date).getTime()) {
    return null;
  }
  return newest.solicited ? newest.kind : null;
}

/**
 * The printable phrase per class. Fixed, except for the two kinds a family can hold
 * SEVERAL of at once — drafted approvals and email-alert offers — where telling them
 * apart is the entire point of the question, so each carries its own row's phrase
 * instead (`namedApprovals`, `emailAlertOfferSubject`).
 */
const SUBJECT: Record<Exclude<OpenQuestionKind, 'approval' | 'email_alert_add'>, string> = {
  intro_optin: 'introductions to other Hale families nearby',
  intro_proposal: 'meeting the family nearby',
  plan_offer: 'the plan I offered',
  checkup_offer: 'booking that visit',
  activity_followup: 'what I said I would come back to you about',
  founder_welcome_offer: 'sending your welcome note to the new family',
  registration_readiness: 'getting set up for the registration morning',
  // No name in it, deliberately: the parent typed a number and a first name, and this
  // phrase can end up in a list Hale prints back (rule #1 — nothing about the person on
  // the other end of an invite they have not answered).
  co_parent_assent: 'texting your co-parent',
  // No child name, deliberately: this phrase can end up in a list Hale prints back, and
  // the ask itself is the only place the names belong (rule #1).
  evening_check_in: 'how today went',
  // No child name, deliberately: this phrase can end up in a list Hale prints back, and
  // the ask itself is the only place the name belongs (rule #1).
  weekday_care: 'how your weeks are covered',
  // No provider name and no child name: this phrase can end up in a list Hale prints
  // back, and the ask itself is the only place either belongs (rule #1).
  daycare_followup: 'how daycare is going',
};

/**
 * MAY A BARE AFFIRMATIVE EXECUTE THIS KIND, RIGHT NOW?
 *
 * Only when every open question is of that one kind. This is the approvals module's own
 * first decision — "an ambiguous affirmative never executes" — finally applied across all
 * of them instead of within one.
 *
 * IT BECAME NECESSARY THE MOMENT THE ASKS STOPPED PRINTING KEYWORDS. The intro card used
 * to end "Reply YES INTRO", and that two-word answer is what kept a bare "yes" out of the
 * intro question entirely — the approvals grammar could own every bare affirmative safely
 * precisely because the intro lane had its own vocabulary. Composing the card removed the
 * disambiguator and left the priority rule behind it, so a parent answering "Want me to
 * introduce you?" with "yes" would have approved an unrelated calendar write. Consent
 * applied to the wrong question (rule #4), and no test caught it because every handler
 * still behaved exactly as documented.
 *
 * WHAT REPLACES THE PRIORITY RULE IS ASKING. The old order (approvals beat health beat
 * plans) was a tie-break invented when Hale had no way to ask which; it always resolved a
 * coin flip in favour of the most expensive wrong answer being possible. Now the turn
 * falls through to the resolver, which either recognises which question the words name or
 * returns `ambiguous` and Hale asks in one sentence. Slower by one round trip, and it
 * cannot execute the wrong thing.
 *
 * An ORDINAL is exempt and is not routed here: "yes 2" cannot be conversation and cannot
 * be an answer to anything but a numbered list.
 *
 * `kind: null` is for a handler that owns no TRACKED question. Nothing in the shipped
 * chain passes it any more — the health checkpoint was the last one, and its offer half is
 * now a listed kind — but it stays because it is the correct reading for a handler that
 * claims a bare word off state this module does not model: any open question at all makes
 * that word ambiguous for it.
 *
 * An EMPTY list is vacuously true, and that is the correct reading rather than a
 * convenience: with nothing outstanding there is nothing for a bare "yes" to be ambiguous
 * WITH, and each handler still has to find something of its own to act on.
 */
export function soleOpenKind(
  questions: readonly OpenQuestion[],
  kind: OpenQuestionKind | null,
): boolean {
  // The one exception to "every question must be of this kind": the parent is doing
  // exactly what the newest message told them to do (ads-week audit, 2026-08-28) —
  // see {@link newestSolicitedKind} for how narrow the claim is.
  if (kind !== null && newestSolicitedKind(questions) === kind) return true;
  return questions.every((question) => question.kind === kind);
}

export interface OpenQuestionReader {
  open(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<OpenQuestion[]>;
}

/**
 * The per-kind readers, injected — each one the function the OWNING module already
 * exports, so this file adds no second opinion about whether anything is open.
 */
export interface OpenQuestionSources {
  /** The approvals spine's own pending list, oldest first. */
  pendingApprovals(database: Database, familyId: string): Promise<PendingAction[]>;
  /** True when the discoverability ask was delivered and carries no answer yet. */
  introOptInOpen(
    database: Database,
    input: { familyId: string; parentUserId: string },
  ): Promise<boolean>;
  /** The proposal this family may answer right now, or null. */
  introProposal(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string } | null>;
  /** The live, unexpired plan offer, or null. `askedAt` is the commitment row's own
   * mint time — when the offer sentence went out. */
  planOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string; summary: string; askedAt: Date } | null>;
  /** The live, unexpired health-checkpoint booking offer, or null. */
  checkupOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string; summary: string; askedAt: Date } | null>;
  /**
   * The founder's live, unexpired welcome offer, or null. Null for every other family in
   * the product by construction — the row is only ever written against his.
   */
  founderWelcomeOffer(
    database: Database,
    familyId: string,
    now: Date,
  ): Promise<{ id: string; summary: string; askedAt: Date } | null>;
  /**
   * The activity follow-up Hale still owes this family, or null.
   *
   * NO `now`, unlike the two offers, and the omission is deliberate: they stop being
   * ANSWERABLE when their moment passes, while a promise does not stop being OWED by
   * getting late. It stays here until the sweep keeps it or a cancellation voids it.
   */
  activityPromise(
    database: Database,
    familyId: string,
  ): Promise<{ id: string; summary: string; askedAt: Date } | null>;
  /**
   * The registration ladder's readiness checklist, while its ask is still Hale's LAST
   * WORD to this parent — or null.
   *
   * NO ROW AND NO COLUMN BEHIND IT, unlike every source above, and the reason is the
   * one this module's own header states: openness is already implied by state somebody
   * owns, and here that state is the message ledger. The reader (registration/sequence/
   * prepare-reply.ts) asks two questions of it — when did the ask last go out, and has
   * anything gone out since — and a question that stayed open for its own three-day
   * interval would have claimed the "yes" a parent said to the coach's own prose
   * question in the middle of it.
   *
   * `askedAt` is the NEWEST ask, so the battle plan's re-ask the evening before
   * outranks an older solicited question rather than losing to it.
   */
  registrationReadiness(
    database: Database,
    familyId: string,
    parentUserId: string,
    now: Date,
  ): Promise<{ id: string; summary: string; askedAt: Date } | null>;
  /**
   * The co-parent invite THIS parent still owes a yes/no on, or null (VIL-355).
   *
   * Per-PARENT rather than per-family, like the intro opt-in and for the same reason:
   * the scope question was put to the parent who typed the number, and nobody else in
   * the household may answer it — a co-parent's "yes" must not authorise a disclosure
   * they were never asked about.
   */
  coParentAssent(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<{ id: string; askedAt: Date } | null>;
  /**
   * The email alerts this parent has not answered — a LIST, unlike every other offer
   * here, because the outbound gate permits three a day and each one asks about a
   * different occasion. Listing them all is what makes a bare affirmative ambiguous
   * between two of them rather than silently binding to one.
   *
   * Per-PARENT, like the intro opt-in and the co-parent scope question: the offer was put
   * to one phone, and a co-parent who never saw the text must not be able to answer it.
   * The TTL is applied inside the reader, so a lapsed offer is never listed.
   *
   * Each row brings its OWN `subject` as well as its summary, for the reason approvals
   * do: a single fixed phrase would print "Which one - X, or X?" the moment two are
   * standing, and a word pick cannot land on a subject the other one also says.
   */
  emailAlertOffers(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<ReadonlyArray<{ id: string; summary: string; subject: string; askedAt: Date }>>;
  /**
   * The evening check-in, while its ask is Hale's last word to this parent and the
   * morning has not come — or null (VIL-353, channel/checkin/reply.ts).
   *
   * Per-PARENT like the intro opt-in and the co-parent assent: the question went to one
   * phone, and a co-parent's evening is not the one Hale asked about.
   */
  eveningCheckIn(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<{ id: string; askedAt: Date } | null>;
  /**
   * The weekday-care ask, while it is Hale's last word to this parent and inside its
   * 48h window — or null (VIL-360, channel/weekday-care/question.ts).
   *
   * Per-PARENT like the evening check-in and for the same reason: the question went to
   * one phone. Ledger-derived like it too, so there is no row to keep in step.
   */
  weekdayCare(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<{ id: string; askedAt: Date } | null>;
  /**
   * The daycare follow-up, while its ask is Hale's last word to this parent and inside
   * its window — or null (VIL-360, channel/followup/question.ts).
   *
   * Per-PARENT, because the follow-up lane sends to one seat.
   */
  daycareFollowup(
    database: Database,
    input: { familyId: string; parentUserId: string; now: Date },
  ): Promise<{ id: string; askedAt: Date } | null>;
}

/**
 * Every open question, read in parallel.
 *
 * APPROVALS ARE LISTED INDIVIDUALLY, up to the same ceiling a numbered list used to print.
 * They have to be: with two drafted changes open, "yes to the swim one" is only resolvable
 * if the swim one is a thing that can be named. The ceiling is {@link MAX_LISTED_APPROVALS}
 * and comes from the same constant the ordinal grammar reads, so a question the resolver
 * can be told about is exactly a question a parent could have been shown.
 *
 * A FAILING READER IS NOT AN EMPTY LIST. It throws, and the turn defers into the queue's
 * own backoff, because "no questions are open" is the answer that sends a parent's yes to
 * the coach — and a coach that has been told nothing is pending will say so.
 */
export function createOpenQuestionReader(sources: OpenQuestionSources): OpenQuestionReader {
  return {
    async open(database, input) {
      const [
        approvals,
        optIn,
        proposal,
        offer,
        checkup,
        promise,
        welcome,
        readiness,
        assent,
        emailOffers,
        evening,
        weekdayCare,
        daycareFollowup,
      ] = await Promise.all([
          sources.pendingApprovals(database, input.familyId),
          sources.introOptInOpen(database, {
            familyId: input.familyId,
            parentUserId: input.parentUserId,
          }),
          sources.introProposal(database, input.familyId, input.now),
          sources.planOffer(database, input.familyId, input.now),
          sources.checkupOffer(database, input.familyId, input.now),
          sources.activityPromise(database, input.familyId),
          sources.founderWelcomeOffer(database, input.familyId, input.now),
          sources.registrationReadiness(database, input.familyId, input.parentUserId, input.now),
          sources.coParentAssent(database, input),
          sources.emailAlertOffers(database, input),
          sources.eveningCheckIn(database, input),
          sources.weekdayCare(database, input),
          sources.daycareFollowup(database, input),
        ]);

      const questions: OpenQuestion[] = namedApprovals(approvals).slice(
        0,
        MAX_LISTED_APPROVALS,
      );

      if (optIn) {
        questions.push({
          id: introOptInQuestionId(input.familyId),
          kind: 'intro_optin',
          description: 'Whether to be introduced to other Hale families nearby',
          subject: SUBJECT.intro_optin,
          answerable: KIND_ANSWERABLE.intro_optin,
          // The ask time is not threaded off the ledger row here; null disables the
          // recency precedence whenever this question is open (fail toward asking).
          askedAt: null,
          solicited: SOLICITED.intro_optin,
        });
      }
      if (proposal) {
        questions.push({
          id: proposal.id,
          kind: 'intro_proposal',
          // Not one fact about the other household — the same rule the card itself keeps.
          description: 'Whether to meet one nearby Hale family',
          subject: SUBJECT.intro_proposal,
          answerable: KIND_ANSWERABLE.intro_proposal,
          askedAt: null,
          solicited: SOLICITED.intro_proposal,
        });
      }
      if (offer) {
        // The commitment's own `summary`, which the ledger's contract already requires to
        // be one short parent-safe sentence with no child detail.
        questions.push({
          id: offer.id,
          kind: 'plan_offer',
          description: offer.summary,
          subject: SUBJECT.plan_offer,
          answerable: KIND_ANSWERABLE.plan_offer,
          askedAt: offer.askedAt,
          solicited: SOLICITED.plan_offer,
        });
      }
      if (checkup) {
        // The same contract, from the same ledger: one short parent-safe sentence built
        // from the reviewed checkpoint's own task (lib/health/offer.ts).
        questions.push({
          id: checkup.id,
          kind: 'checkup_offer',
          description: checkup.summary,
          subject: SUBJECT.checkup_offer,
          answerable: KIND_ANSWERABLE.checkup_offer,
          askedAt: checkup.askedAt,
          solicited: SOLICITED.checkup_offer,
        });
      }
      if (welcome) {
        // The commitment's own `summary` once more. It names a poster and no household,
        // which is exactly what the ping already said to this same reader (rule #1).
        questions.push({
          id: welcome.id,
          kind: 'founder_welcome_offer',
          description: welcome.summary,
          subject: SUBJECT.founder_welcome_offer,
          answerable: KIND_ANSWERABLE.founder_welcome_offer,
          askedAt: welcome.askedAt,
          solicited: SOLICITED.founder_welcome_offer,
        });
      }
      if (readiness) {
        // The source's own one-line summary: Hale's words from its own ask, naming the
        // portal and nothing about the child (rule #1).
        questions.push({
          id: readiness.id,
          kind: 'registration_readiness',
          description: readiness.summary,
          subject: SUBJECT.registration_readiness,
          answerable: KIND_ANSWERABLE.registration_readiness,
          askedAt: readiness.askedAt,
          solicited: SOLICITED.registration_readiness,
        });
      }
      if (assent) {
        // NOT the invite's display name and not the number: the parent typed both about
        // somebody who has not answered, and this description goes to a model (rule #1).
        questions.push({
          id: assent.id,
          kind: 'co_parent_assent',
          description: 'Whether to text the number you gave me and seat them as your co-parent',
          subject: SUBJECT.co_parent_assent,
          answerable: KIND_ANSWERABLE.co_parent_assent,
          askedAt: assent.askedAt,
          solicited: SOLICITED.co_parent_assent,
        });
      }
      // OLDEST FIRST — the order the texts reached the phone — because a position printed
      // against two notices about the same occasion has to mean what a parent means by
      // "the first one".
      const orderedOffers = [...emailOffers].sort(
        (a, b) => a.askedAt.getTime() - b.askedAt.getTime(),
      );
      const offerPositions = duplicatePositions(orderedOffers.map((offer) => offer.subject));
      for (const [index, emailOffer] of orderedOffers.entries()) {
        // The offer row's own one-line summary: the title Hale already texted this parent
        // and nothing else — never the subject line, never the snippet (rule #1).
        questions.push({
          id: emailOffer.id,
          kind: 'email_alert_add',
          description: emailOffer.summary,
          // The offer's OWN phrase, so two standing alerts can be told apart at all — and
          // its position when even the titles are the same.
          subject: `${emailOffer.subject}${offerPositions[index]}`,
          answerable: KIND_ANSWERABLE.email_alert_add,
          askedAt: emailOffer.askedAt,
          solicited: SOLICITED.email_alert_add,
        });
      }
      if (evening) {
        // Hale's own words about its own ask, with no child name in them — the names are
        // in the text the parent is holding, and this line goes to a model (rule #1).
        questions.push({
          id: evening.id,
          kind: 'evening_check_in',
          description: 'How the day went at home',
          subject: SUBJECT.evening_check_in,
          answerable: KIND_ANSWERABLE.evening_check_in,
          askedAt: evening.askedAt,
          solicited: SOLICITED.evening_check_in,
        });
      }
      if (weekdayCare) {
        // Hale's own words about its own ask, with no child name in them — the name is
        // in the text the parent is holding, and this line goes to a model (rule #1).
        questions.push({
          id: weekdayCare.id,
          kind: 'weekday_care',
          description: 'How this household covers its weekdays',
          subject: SUBJECT.weekday_care,
          answerable: KIND_ANSWERABLE.weekday_care,
          askedAt: weekdayCare.askedAt,
          solicited: SOLICITED.weekday_care,
        });
      }
      if (daycareFollowup) {
        // Hale's own words about its own ask, with neither the provider nor the child
        // in them — both are in the text the parent is holding (rule #1).
        questions.push({
          id: daycareFollowup.id,
          kind: 'daycare_followup',
          description: 'How the daycare they told me about is going',
          subject: SUBJECT.daycare_followup,
          answerable: KIND_ANSWERABLE.daycare_followup,
          askedAt: daycareFollowup.askedAt,
          solicited: SOLICITED.daycare_followup,
        });
      }
      if (promise) {
        // The commitment's own `summary` again — one short parent-safe sentence, the
        // ledger's contract for every row on it.
        questions.push({
          id: promise.id,
          kind: 'activity_followup',
          description: promise.summary,
          subject: SUBJECT.activity_followup,
          answerable: KIND_ANSWERABLE.activity_followup,
          askedAt: promise.askedAt,
          solicited: SOLICITED.activity_followup,
        });
      }
      return questions;
    },
  };
}

/**
 * The drafted actions, each named by something a parent could actually pick out.
 *
 * THE TYPE LABEL AND NEVER THE PAYLOAD. A drafted action can be a teenager's, and
 * `actionTypeLabel` is derived from the type alone (rule #1, format/labels.ts).
 *
 * WHICH IS WHY DUPLICATES HAPPEN. Two calendar additions are two different changes with
 * one label, and "Which one - add to your calendar, or add to your calendar?" is not a
 * question. The numbered menu this replaced did not have that problem, and dropping the
 * menu without replacing what it did would have moved a dead end rather than removed one.
 * So a label that repeats gets its POSITION in the same oldest-first list the ordinal
 * grammar resolves against — as a description ("the first"), not as an instruction
 * ("YES 1"). A parent says "the first one" and it resolves; "yes 1" also still resolves,
 * because no read was removed.
 *
 * A label that does not repeat is left completely alone, which is the common case.
 *
 * A DRAFT THAT HAS NOT CLEARED THE REVIEWER IS STILL A QUESTION, and it is still listed —
 * the parent can say "drop that one" and `declineDraftedAction` will do it. What it is
 * not is ACCEPTABLE: `approveDraftedAction` refuses any draft whose verdict is not
 * `approved` (rule #3), so its yes is marked closed here and the resolver will not bind an
 * acceptance to it (2026-08-20: it did, and the parent was answered with a sentence about
 * Hale's own review instead).
 */
function namedApprovals(approvals: ReadonlyArray<PendingAction>): OpenQuestion[] {
  // Names EVERY pending action and lets each caller take what it can show. The two
  // callers cut the list at the same ceiling but they cut it at different moments (one
  // before sending it to a model, one while writing a sentence with an overflow count),
  // and slicing here would silently zero that count.
  const labels = approvals.map((action) => actionTypeLabel(action.actionType));
  const positions = duplicatePositions(labels);
  return approvals.map((action, index) => {
    const label = labels[index] as string;
    const position = positions[index] as string;
    return {
      id: action.actionId,
      kind: 'approval' as const,
      description: `${label}${position}`,
      subject: `${label.toLowerCase()}${position}`,
      answerable: { yes: action.reviewerApproved, no: true },
      // Drafted-at is not threaded through PendingAction; null keeps the recency
      // precedence OFF whenever a draft is pending, which is the safe side (a bare YES
      // near an open approval is the expensive coin flip).
      askedAt: null,
      solicited: SOLICITED.approval,
    };
  });
}

/** Only as many as a list can hold — {@link MAX_LISTED_APPROVALS} is 3. */
const ORDINAL_WORD = ['first', 'second', 'third'];

/**
 * ` (the first)` for every phrase that REPEATS in this list, and '' for the rest.
 *
 * TWO KINDS NEED IT and the rule has to be one rule: a family can hold three drafted
 * changes and three email-alert offers, and either pair can arrive carrying one phrase —
 * two calendar adds share a type label, two notices about the same occasion share a
 * title. "Which one - X, or X?" is not a question, and a word pick cannot land on a word
 * both options say (`distinctiveWords` drops it), so a repeated phrase gets its POSITION
 * in the list as a description a parent can answer — never as an instruction.
 *
 * The caller owns the ORDER, because the position only means something if the list is in
 * the order the parent met them: oldest first, for both callers.
 */
function duplicatePositions(phrases: readonly string[]): string[] {
  return phrases.map((phrase, index) =>
    phrases.filter((other) => other === phrase).length > 1
      ? ` (the ${ORDINAL_WORD[index] ?? `${index + 1}`})`
      : '',
  );
}

/**
 * The same names, for the clarifying sentence the APPROVAL grammar sends when a bare
 * "yes" arrives with several drafts pending.
 *
 * One namer, two callers, deliberately: the question Hale prints and the question the
 * resolver is shown have to be the same question, or a parent answers "the second one"
 * about a list that was numbered differently behind the scenes.
 */
export function approvalSubjects(pending: ReadonlyArray<PendingAction>): string[] {
  return namedApprovals(pending).map((question) => question.subject);
}

/** The opt-in question is an ABSENCE — a delivered ask with no consent row behind it — so
 * it has no row id of its own and gets a derived one. Exported because the applier reads
 * it back to know which question was answered. */
export function introOptInQuestionId(familyId: string): string {
  return `intro_optin:${familyId}`;
}
