import type { Database } from '@hale/db';
import {
  type EmailCaptureDeps,
  handleEmailCaptureReply,
} from '~/lib/channel/email-capture/reply';
import {
  type NameCaptureDeps,
  handleNameCaptureReply,
} from '~/lib/channel/identity/name-reply';
import {
  type SequenceReplyDeps,
  handleSequenceReply,
} from '~/lib/registration/sequence/reply';
import { type HealthReplyDeps, handleHealthCheckpointReply } from '~/lib/health/reply';
import { type PlanReplyDeps, handlePlanYes } from '~/lib/channel/plan/reply';
import {
  type ResolvedIntroAnswer,
  type VillageIntroReplyDeps,
  handleVillageIntroReply,
} from '~/lib/village/intros/reply';
import { type ApprovalSpine, resolveApproval } from './approval';
import { type OpenQuestionKind, soleOpenKind } from './open-questions';
import { checkupDraftedReply, healthDoneReply } from './copy';
import { matchFastPath } from './fast-path';
import { readAffirmative } from '~/lib/channel/affirmative';
import type { DeterministicHandler, HandlerContext, HandlerVerdict } from './route';

/**
 * May this handler act on a BARE affirmative right now?
 *
 * An ordinal ("yes 2") and an undo are exempt: neither can be conversation and neither can
 * be an answer to any question but the numbered one. Everything else consults
 * {@link soleOpenKind} — see there for why the old priority order had to go.
 */
async function mayClaimBareWord(
  ctx: HandlerContext,
  command: { verb: string; index: number | null },
  kind: OpenQuestionKind,
): Promise<boolean> {
  if (command.index !== null || command.verb === 'undo') return true;
  return soleOpenKind(await ctx.openQuestions(), kind);
}

/**
 * A resolved intro answer, in the shape the lane's own reader produces.
 *
 * The lane is keyed on the two-word keyword's NOUN (`intro` vs `intros`), and the resolver
 * is keyed on the question kind. This is the one place the two vocabularies meet, and it
 * is three lines rather than a shared enum because the lane's shape is the older and the
 * more load-bearing of the two: it is what the consent ledger's writer branches on.
 */
function introKeywordFrom(ctx: HandlerContext): ResolvedIntroAnswer | null {
  const resolved = ctx.resolved;
  if (resolved?.kind !== 'intro_optin' && resolved?.kind !== 'intro_proposal') return null;
  return {
    target: resolved.kind === 'intro_optin' ? 'discoverability' : 'proposal',
    granted: resolved.polarity === 'yes',
    confidence: resolved.confidence,
  };
}

/**
 * VIL-220 · C1 — the deterministic handlers, and the order they run in.
 *
 * Each one adapts a module that already owns its own certainty. None of them re-decides
 * anything: the approval preconditions live in the actions spine, the health matching
 * lives in M8. What lives HERE is only the mapping from those verdicts to a text
 * message, and the order.
 *
 * THE ORDER. "yes" is the one word several handlers could claim, and the rule that
 * settles it is not "approvals are more important" — it is that a handler may only claim a
 * word when it has something concrete for the word to mean, AND when that thing is the
 * only thing the word could mean:
 *
 *   · The approval handler claims a bare affirmative ONLY when an action is actually
 *     drafted and waiting. With none — the overwhelmingly common case — it declines,
 *     and the health nudge's own offer gets its answer. That is what stops the first
 *     handler in the chain from starving the ones behind it, and it is asserted in
 *     handlers.test.ts in both directions.
 *
 *   · When TWO KINDS of question are open, NOBODY claims it (see `soleOpenKind` in
 *     open-questions.ts). Approvals used to win that tie on the grounds that a mis-fired
 *     calendar write is the most expensive wrong answer — which was true, and was still a
 *     coin flip resolved in favour of the expensive outcome being possible. It survived
 *     only because the intro card ended "Reply YES INTRO", so a bare "yes" could not have
 *     meant the intro. Composing that card (2026-08-13) removed the disambiguator, and
 *     the tie-break went with it: the turn now falls through to the natural-reply stage,
 *     which either reads which question the words name or has Hale ask, in a sentence.
 *
 * An ORDINAL ("YES 2") never reaches the health handler at all: M8 matches exact words,
 * so it declines anything carrying a number, and the approval handler answers it even
 * when the queue is empty — and it never waits on `soleOpenKind`, because a number cannot
 * be an answer to anything but a numbered list.
 *
 * WHY REGISTRATION IS LAST. The first two handlers claim only words they recognise
 * exactly. M7's does something none of the others do: inside an open check-in window it
 * also claims a message it CANNOT read, answering it with the re-ask menu (bounded to
 * one per window by `reasked_at`). A handler that claims unreadable messages placed
 * ahead of one that matches exact words would starve it — a parent texting "done" about
 * their OHIP paperwork during an open registration window would get "how did
 * registration go?" and their answer would go unfiled. Narrow before broad puts each
 * word with the handler that actually recognises it, and leaves M7 exactly where its own
 * module note puts it: last before the conversational layer.
 */

/**
 * Village intros — YES INTROS / NO INTROS / YES INTRO / NO INTRO, and, since 2026-08-13,
 * whatever else the parent actually said.
 *
 * NOTHING PRINTS THOSE FOUR PHRASES ANY MORE. The asks are composed and ask their
 * question in English (lib/village/intros/voice.ts). The phrases are still READ, because
 * a parent who learned one must not discover it has been taken away — and reading them
 * here is free, which is why this handler still runs before the model does.
 *
 * FIRST IN THE CHAIN, and the narrowest thing in it: it claims a two-word phrase whose
 * second word is `intro` or `intros` and nothing else, so it cannot starve a handler
 * behind it — none of them recognise those phrases at all (the approval grammar
 * declines them because they are not bare affirmatives).
 *
 * It goes first because one of the four words is a REVOCATION. "NO INTROS" turning off
 * a family's discoverability must not depend on which other handlers happened to
 * decline it that day, and first is the only position where that is true by
 * construction rather than by audit.
 */
export function villageIntroHandler(deps: VillageIntroReplyDeps): DeterministicHandler {
  return {
    name: 'village_intro',
    // Both intro questions. The lane already distinguishes them by the noun in the
    // keyword; on a resolved turn the KIND carries that distinction instead, and the
    // grade above it is what makes the proposal (a disclosure) need `high` while the
    // opt-in does not.
    resolves: new Set<OpenQuestionKind>(['intro_optin', 'intro_proposal']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleVillageIntroReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
          resolved: introKeywordFrom(ctx),
        },
        deps,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}

/**
 * C1's own approval grammar, resolved against the app's approve/decline/undo spine.
 * Declines anything that is not a command, and anything that is a command with nothing
 * to command — see {@link resolveApproval}.
 */
export function approvalHandler(spine: ApprovalSpine): DeterministicHandler {
  return {
    name: 'approval',
    resolves: new Set<OpenQuestionKind>(['approval']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      // A resolved answer NAMES its action, so it does not need — and must not use — the
      // ordinal grammar: the two reads of the pending list are a co-parent's tap apart,
      // and only an id survives that.
      const resolved = ctx.resolved?.kind === 'approval' ? ctx.resolved : null;
      const command = resolved
        ? ({ verb: resolved.polarity, index: null } as const)
        : matchFastPath(ctx.body);
      if (!command) return { claimed: false };
      if (!resolved && !(await mayClaimBareWord(ctx, command, 'approval'))) {
        return { claimed: false };
      }

      const outcome = await resolveApproval(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          command,
          now: ctx.now,
          targetActionId: resolved?.questionId,
        },
        spine,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}

/**
 * The address a parent texts back after Hale asked for one (VIL-249).
 *
 * THIRD, and the position is the point. It goes AFTER the approval grammar because an
 * approval word is a decision that executes something, and no shape check may ever be
 * what claims one — the two cannot actually collide (no approval command contains an
 * '@'), and ordering it this way means they still cannot if either grammar widens.
 * It goes BEFORE M8 and M7 because those match exact words — "done", "we got in" — and
 * an address is none of them, so nothing behind it is starved. (The CASL keywords are
 * upstream of the whole chain: A3 answers STOP/HELP/START at the webhook, and this
 * handler re-checks for one anyway rather than assume it.)
 *
 * It is the narrowest thing in the chain after the intro keywords: it claims only a
 * message that IS an address, and only for a family Hale actually asked.
 */
export function emailCaptureHandler(deps: EmailCaptureDeps): DeterministicHandler {
  return {
    name: 'email_capture',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleEmailCaptureReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
        },
        deps,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}

/**
 * The name a parent texts back after Hale asked what to call them.
 *
 * LAST, and the position is as deliberate as the address capture's is. This is the
 * BROADEST shape check in the chain — a bare word — so it has to claim after everything
 * that matches a specific one. "Done" is a health outcome, "yes" is a plan acceptance and
 * "we got in" is a registration result, and each of those handlers gets first refusal on
 * its own vocabulary; only a message none of them recognised can be somebody's name.
 * Ordering it any earlier would mean a family with an open name ask could not answer a
 * health nudge without being renamed for it.
 *
 * Three conditions have to hold together before a word is written to an account: it is
 * name-shaped (see soleGivenName — no digits, no address, at most three words, not an
 * ordinary reply), Hale actually asked this family, and there is no name on file yet. The
 * write itself carries the third as `name IS NULL` in its own WHERE, so the answer to a
 * race is settled by Postgres rather than by the order two texts arrived in.
 */
export function nameCaptureHandler(deps: NameCaptureDeps): DeterministicHandler {
  return {
    name: 'name_capture',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleNameCaptureReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
        },
        deps,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}

/**
 * M8's health-nudge replies. Two outcomes reach a parent: the paperwork is filed as
 * handled, or a checkup is DRAFTED for their approval — Hale never books (rule #4), and
 * the reply says so rather than implying an appointment exists.
 *
 * M8 shipped this handler with no caller; C1 is its first one, which is why the two
 * acknowledgement lines live in C1's copy rather than M8's.
 */
export function healthReplyHandler(deps: HealthReplyDeps): DeterministicHandler {
  return {
    name: 'health',
    // The OFFER half only. "Done" is the other half of the same sentence and is not a
    // polarity — filing a checkpoint as handled writes a permanent suppression — so it
    // stays a word this handler reads for itself and is not a question the resolver may
    // answer (see the OpenQuestionKind note in open-questions.ts).
    resolves: new Set<OpenQuestionKind>(['checkup_offer']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const resolved = ctx.resolved?.kind === 'checkup_offer' ? ctx.resolved : null;
      // A tick or the word "done" is unambiguous and claims immediately. A bare "yes" is
      // not, and M8's own reading of one drafts an appointment — so it waits for
      // `soleOpenKind` like every other bare affirmative. A RESOLVED answer skips the
      // wait: it named its question, which is what the wait exists to establish.
      if (
        !resolved &&
        readAffirmative(ctx.body) === 'yes' &&
        !soleOpenKind(await ctx.openQuestions(), 'checkup_offer')
      ) {
        return { claimed: false };
      }
      const outcome = await handleHealthCheckpointReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
          resolved: resolved ? 'booking' : null,
        },
        deps,
      );
      switch (outcome.status) {
        case 'recorded_done':
          return { claimed: true, outcome: outcome.status, reply: healthDoneReply() };
        case 'drafted_for_approval':
          return {
            claimed: true,
            outcome: outcome.status,
            reply: checkupDraftedReply(),
            // The offer is closed by the message that told the parent it was taken, never
            // before it — a turn that drafted and then failed to reply must be re-drivable
            // against an offer that is still standing (the MEM-10 send-time discipline).
            afterSend: (channelMessageId) =>
              deps.fulfillOffer(database, {
                familyId: ctx.familyId,
                channelMessageId,
                now: ctx.now,
              }),
          };
        default:
          return { claimed: false };
      }
    },
  };
}

/**
 * The full coaching plan a parent said YES to.
 *
 * PLACED DIRECTLY AFTER HEALTH, which puts it third among the three handlers that can
 * claim a bare affirmative, and the ordering rule is the one stated at the top of this
 * file extended by one step: among handlers that recognise the SAME word, the one whose
 * wrong answer costs most goes first.
 *
 *   · APPROVALS still own a bare YES whenever a draft is pending, and that stays true.
 *     A mis-fired approval executes something the parent cannot see and needs an undo.
 *     So when a draft AND a plan offer are both open, YES means the draft — the known
 *     rule, and the same trade the health handler already lives under.
 *   · HEALTH is next: a mis-read "yes" there drafts an appointment or files paperwork
 *     as handled, which silences a records reminder for months.
 *   · A PLAN is last, because its wrong answer is the cheapest of the three — three
 *     texts of parenting advice a parent did not ask for right now. It also claims the
 *     narrowest slice of the word: only when an offer is OPEN and less than two days
 *     old (see plan/reply.ts on why the claim expires at all).
 *
 * It is the first handler that ANSWERS FOR ITSELF, and the only one that never hands
 * the router a body at all. A plan is two or three ordered messages, which the
 * verdict's single `reply` cannot express — so it sends through its own ordered loop
 * and returns `reply: null`, the contract's existing shape for a handler that has
 * already spoken. There is no fallback line either: a turn that cannot compose
 * something sendable throws {@link PlanDeferred} and the drain redrives it, because a
 * plan that lands late beats an apology that lands on time.
 */
export function planReplyHandler(deps: PlanReplyDeps): DeterministicHandler {
  return {
    name: 'coach_plan',
    resolves: new Set<OpenQuestionKind>(['plan_offer']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const resolved = ctx.resolved?.kind === 'plan_offer';
      if (!resolved && readAffirmative(ctx.body) === 'yes') {
        if (!soleOpenKind(await ctx.openQuestions(), 'plan_offer')) return { claimed: false };
      }
      const outcome = await handlePlanYes(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          conversationId: ctx.conversationId,
          body: ctx.body,
          phoneE164: ctx.phoneE164,
          now: ctx.now,
          resolved: resolved ? 'yes' : null,
        },
        deps,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      // Every other outcome ends the turn with nothing left for the router to say. The
      // plan (or the age-gate refusal) has already gone out through this handler's own
      // ordered send; `not_delivered` means the wire ate it, and a second body there
      // would be an apology arriving after messages that may yet land. There is no
      // preset line on this path at all — a turn with nothing sendable THROWS
      // (PlanDeferred) so the drain redrives it.
      return { claimed: true, outcome: outcome.status, reply: null };
    },
  };
}

/**
 * M7's registration check-in replies — "we got in", "waitlisted #3", "missed it".
 *
 * Unlike the two above, this one renders its own copy (the outcome shapes carry a
 * `reply`), so the adapter passes it through untouched: the 36-hour waitlist clock and
 * the sentence describing it are set in the same call, and a second copy here could
 * disagree with the deadline actually stored.
 *
 * THE RE-ASK IS THE COACH'S NOW (VIL-221 · C2), which is what M7's own module note said
 * should happen the moment a conversational layer existed. Until C2 the check-in menu
 * was the best answer available to an unreadable message; now it is the worst, because
 * an unreadable message is overwhelmingly a parent asking Hale something rather than
 * reporting a registration outcome in words M7 does not know. So `reasked` returns
 * `claimed: false` and the turn falls through to the model.
 *
 * `recorded` is still claimed, and that asymmetry is the whole point: the three
 * certainties M7 CAN read start a 36-hour clock and must never be paraphrased by a
 * model, while everything it cannot read was never M7's to answer.
 *
 * The stamp is still spent on the way past — `handleSequenceReply` writes `reasked_at`
 * before returning `reasked`, and that is left alone deliberately. It belongs to M7's
 * window bookkeeping, it costs the family nothing now that both branches fall through
 * to the coach, and reaching into M7 to suppress it would put a second opinion about
 * the window's state in a module that does not own one.
 */
export function sequenceReplyHandler(deps: SequenceReplyDeps): DeterministicHandler {
  return {
    name: 'registration',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleSequenceReply(
        database,
        { familyId: ctx.familyId, body: ctx.body, now: ctx.now },
        deps,
      );
      if (outcome.status !== 'recorded') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: outcome.reply };
    },
  };
}
