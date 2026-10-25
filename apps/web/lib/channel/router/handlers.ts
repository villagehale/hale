import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { answeredOnTheSameChannel, handleEveningCheckInReply } from '~/lib/channel/checkin/reply';
import type { EveningRequestReader } from '~/lib/channel/checkin/request';
import { connectorRevokeReply } from '~/lib/channel/connect/copy';
import {
  type ConnectOfferTarget,
  connectOfferTarget,
  matchConnectorDisconnectRequest,
  matchConnectorRequest,
  matchFreshConnectorFollowUp,
} from '~/lib/channel/connect/detect';
import { defaultFreshLinkPorts, textFreshConnectorLink } from '~/lib/channel/connect/fresh-link';
import { offerConnectorLink, offerConnectorLinks } from '~/lib/channel/connect/offer';
import { revokeConnectorByText } from '~/lib/channel/connect/revoke';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';
import { writeConsentAsk } from '~/lib/channel/consent-ask';
import { f14EnabledFor } from '~/lib/channel/f14';
import { type FounderReplyDeps, handleFounderWelcomeReply } from '~/lib/channel/founder/reply';
import { type NameCaptureDeps, handleNameCaptureReply } from '~/lib/channel/identity/name-reply';
import {
  type ParentCallNameVoice,
  handleParentCallNameReply,
} from '~/lib/channel/identity/parent-call-name';
import {
  type CoParentNumberDeps,
  deliverCoParentNumberInvite,
} from '~/lib/channel/linq/coparent-invite';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import { type PlanReplyDeps, handlePlanYes } from '~/lib/channel/plan/reply';
import { recMorningCouldUseWhere, recMorningReply } from '~/lib/channel/rec-morning';
import {
  type SaidLineWriter,
  createSaidLineWriter,
  writeConnectorLink,
  writeConnectorLinks,
} from '~/lib/channel/voice/said-line';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { type HealthReplyDeps, handleHealthCheckpointReply } from '~/lib/health/reply';
import {
  handleEmailAlertOfferReply,
  resolveEmailAlertOffer,
} from '~/lib/integrations/email-alert-offer';
import type { OfferReceiptWriter } from '~/lib/integrations/offer-receipt';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { SHORTLIST_ALREADY_APPROVED_ACK } from '~/lib/registration/sequence/copy';
import {
  type PrepareReplyDeps,
  handleCourseBind,
  handleReadinessAnswer,
} from '~/lib/registration/sequence/prepare-reply';
import { type SequenceReplyDeps, handleSequenceReply } from '~/lib/registration/sequence/reply';
import {
  type ResolvedIntroAnswer,
  type VillageIntroReplyDeps,
  handleVillageIntroReply,
} from '~/lib/village/intros/reply';
import { type ApprovalSpine, resolveApproval } from './approval';
import { failureReply, healthDoneReply } from './copy';
import { type OpenQuestionKind, soleOpenKind } from './open-questions';
import type { DeterministicHandler, HandlerContext, HandlerVerdict } from './route';

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
 * Village intros. A model reads what the parent meant. A failed read grants nothing
 * and revokes nothing.
 *
 * FIRST IN THE CHAIN because one answer is a revocation. Turning off a family's
 * discoverability must not depend on which other handlers declined the turn, and
 * first is the only position where that is true by construction.
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
      if (!resolved) return { claimed: false };
      const command = { verb: resolved.polarity, index: null } as const;
      if (
        await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'spend',
        })
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
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
 * A plain ask to connect Google Calendar, Gmail or Drive (the connector handoff).
 *
 * PLACED AFTER the email capture and BEFORE the three bare-affirmative claimers, and
 * the position costs nothing either way: it claims only a message carrying an explicit
 * connect-verb + provider-noun pair (connect/detect.ts), a shape no other handler's
 * vocabulary contains and no bare word can be. What the position buys is the same
 * thing every deterministic handler buys — the model never sees the ask, so the answer
 * is a REAL link minted this turn rather than a composed sentence about one (the
 * registration-context failure class, closed the way the referral tool closed its own:
 * with a fact instead of an instruction).
 *
 * BEFORE FLOOD by construction (the whole chain is), so a parent whose hour is spent
 * still gets their link.
 *
 * Rule #11, all three ways out named: `sent` claims with the locked offer line (EN/FR
 * twin, one segment, link inside it); `not_enrolled` — unreachable from the router,
 * which does not reach the chain without a verified parent channel, but re-proven by
 * the mint — declines to claim and says why in the log; `mint_failed` claims with the
 * honest failure line rather than deferring the turn into hours of queue backoff.
 *
 * A follow-up that does not name the provider ("give me a fresh one", "new link",
 * "it expired") mints the same way when the previous Hale message was already a
 * Gmail or calendar connect link. A later sentence that is not that link is not
 * this ask, and the coach keeps the turn.
 */
async function latestConnectOfferTarget(
  database: Database,
  conversationId: string,
): Promise<ConnectOfferTarget | null> {
  try {
    const rows = await database
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.conversationId, conversationId), isNull(schema.messages.deletedAt)),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(6);
    for (const row of rows) {
      if (row.role !== 'assistant') continue;
      return connectOfferTarget(row.content);
    }
    return null;
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'connector link: could not read the prior offer',
    );
    return null;
  }
}

/**
 * The family group's chat, when THIS message arrived in it. A connect link is one
 * parent's: asked for in the group, it goes to their own 1:1 instead.
 */
async function familyGroupTurn(database: Database, ctx: HandlerContext): Promise<boolean> {
  if (!ctx.inboundChannelMessageId) return false;
  const [family] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, ctx.familyId));
  if (!family?.linqGroupChatId) return false;
  const [message] = await database
    .select({ providerChatId: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, ctx.inboundChannelMessageId));
  return message?.providerChatId === family.linqGroupChatId;
}

export function connectorLinkHandler(
  log: Pick<Console, 'error'> = console,
  saidLine: SaidLineWriter = createSaidLineWriter(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS)),
): DeterministicHandler {
  return {
    name: 'connector_link',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const named = matchConnectorRequest(ctx.body);
      const fresh = named
        ? null
        : matchFreshConnectorFollowUp(ctx.body)
          ? await latestConnectOfferTarget(database, ctx.conversationId)
          : null;
      if (!named && !fresh) return { claimed: false };
      if (
        await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'calendar_email',
        })
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
      }

      const language = await familySpeechLanguage(database, ctx.familyId);
      const target = named ?? fresh;
      if (!target) return { claimed: false };
      if (await familyGroupTurn(database, ctx)) {
        const provider = target === 'both' ? 'both' : asTextConnectProvider(target);
        if (!provider) {
          return { claimed: true, outcome: 'group_link_withheld', reply: null };
        }
        const outcome = await textFreshConnectorLink(
          database,
          { familyId: ctx.familyId, parentUserId: ctx.parentUserId, provider, now: ctx.now },
          // The handler's own writer, so the 1:1 text is written the same way.
          { ...defaultFreshLinkPorts(), saidLine },
        );
        if (outcome !== 'sent') {
          log.error(
            { familyId: ctx.familyId, provider: target, outcome },
            'connector link: asked in the group, 1:1 link not sent',
          );
        }
        return {
          claimed: true,
          outcome: outcome === 'sent' ? 'sent_1to1' : `group_1to1_${outcome}`,
          reply: null,
        };
      }
      if (target === 'both') {
        const outcome = await offerConnectorLinks(database, {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          providers: ['gcal', 'gmail'],
          now: ctx.now,
        });
        switch (outcome.status) {
          case 'minted': {
            // #868: the model writes the text around the two links.
            const reply = await writeConnectorLinks(saidLine, {
              language,
              calendarUrl: outcome.urls[0],
              gmailUrl: outcome.urls[1],
            });
            if (!reply) {
              log.error(
                { familyId: ctx.familyId, provider: target, outcome: 'links_unwritten' },
                'connector link: both-links text could not be written - nothing sent',
              );
              return { claimed: true, outcome: 'links_unwritten', reply: null };
            }
            return { claimed: true, outcome: 'sent', reply };
          }
          case 'not_enrolled':
            log.error(
              { familyId: ctx.familyId, provider: target, outcome: 'not_enrolled' },
              'connector link: mint refused for an unenrolled turn',
            );
            return { claimed: false };
          case 'mint_failed':
            log.error(
              { familyId: ctx.familyId, provider: target, outcome: 'mint_failed' },
              'connector link: mint failed',
            );
            return { claimed: true, outcome: 'mint_failed', reply: failureReply() };
        }
      }

      const outcome = await offerConnectorLink(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        provider: target,
        now: ctx.now,
      });
      switch (outcome.status) {
        case 'minted': {
          // #868: the model writes the text around the one link.
          const reply = await writeConnectorLink(saidLine, {
            language,
            provider: target,
            url: outcome.url,
          });
          if (!reply) {
            log.error(
              { familyId: ctx.familyId, provider: target, outcome: 'links_unwritten' },
              'connector link: link text could not be written - nothing sent',
            );
            return { claimed: true, outcome: 'links_unwritten', reply: null };
          }
          return { claimed: true, outcome: 'sent', reply };
        }
        case 'not_enrolled':
          // Ids and the named outcome only, never the body (rule #1). The coach takes
          // the turn, and its skill knows this branch exists.
          log.error(
            { familyId: ctx.familyId, provider: target, outcome: 'not_enrolled' },
            'connector link: mint refused for an unenrolled turn',
          );
          return { claimed: false };
        case 'mint_failed':
          log.error(
            { familyId: ctx.familyId, provider: target, outcome: 'mint_failed' },
            'connector link: mint failed',
          );
          return { claimed: true, outcome: 'mint_failed', reply: failureReply() };
      }
    },
  };
}

/**
 * "disconnect my calendar" — the same door, the other way.
 *
 * A COMMAND, never an answer. It reads only its own explicit verb+noun shape
 * (connect/detect.ts) and never consults the open questions, so it cannot claim a bare
 * YES or NO and cannot take a turn that belongs to an approval, a plan or a health
 * checkpoint. That is also why its position next to the connector link is free: the two
 * matchers are disjoint by construction and neither shape occurs in any other handler's
 * vocabulary.
 *
 * UNGATED, like the connect half it mirrors. Connect-by-text is live for every family,
 * so gating the undo behind the F14 allowlist would leave most parents able to connect
 * by text and unable to un-connect the same way. A parent ending their own grant is an
 * instruction they gave, not a proactive send, so the dark-launch reasoning does not
 * reach it.
 *
 * Rule #11, all three ways out named and all three answered in the parent's own reply
 * language: `revoked`, `not_connected` (nothing of theirs matched — never a false
 * success), `revoke_failed` (nothing changed, said in French to a French parent).
 */
export function connectorDisconnectHandler(
  log: Pick<Console, 'error'> = console,
): DeterministicHandler {
  return {
    name: 'connector_disconnect',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const provider = matchConnectorDisconnectRequest(ctx.body);
      if (!provider) return { claimed: false };
      if (
        await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'calendar_email',
        })
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
      }

      const outcome = await revokeConnectorByText(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        provider,
      });
      if (outcome.status === 'revoke_failed') {
        // Ids and the named outcome only, never the body and never a token (rule #1).
        log.error(
          { familyId: ctx.familyId, provider, outcome: 'revoke_failed' },
          'connector disconnect: revoke did not land - nothing was changed',
        );
      }
      return {
        claimed: true,
        outcome: outcome.status,
        reply: await connectorRevokeReply(
          await familySpeechLanguage(database, ctx.familyId),
          provider,
          outcome.status,
        ),
      };
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
/**
 * The reply to the confirm of a held Google name — yes keeps it, no asks what to
 * call them, and a different name stores that preference instead. The model reads
 * the answer and writes the receipt; code stores only what passes the shape check.
 *
 * IMMEDIATELY BEFORE the name capture. A bare yes is not a name, so the capture
 * would decline it; this handler has to see it first when a confirm is the latest
 * ask. It declines when the latest ask is the open name question, which is the
 * capture's. A yes that belongs to an approval, a plan, or
 * a health nudge is claimed by those handlers, which sit ahead of this one.
 */
export function parentCallNameHandler(voice: ParentCallNameVoice): DeterministicHandler {
  return {
    name: 'parent_call_name',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const outcome = await handleParentCallNameReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
        },
        voice,
      );
      if (outcome.status === 'declined') return { claimed: false };
      return { claimed: true, outcome: 'parent_call_name', reply: outcome.reply };
    },
  };
}

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
 * The founder's welcome note — his YES, and the note it puts in a new family's thread.
 *
 * PLACED HERE, ahead of the three handlers that read a bare affirmative for a household's
 * own business, and the rule is the one stated at the top of this file: among handlers
 * that recognise the SAME word, the one whose wrong answer costs most goes first.
 * Everything below this line acts on the family that spoke; this one acts on a DIFFERENT
 * household, and an unsolicited text to a stranger in a person's name is the most
 * expensive wrong reading on the chain after an approval that executes something.
 *
 * IT CANNOT STARVE THEM. The offer row is only ever written against the founder's own
 * family (lib/channel/founder/ping.ts), so for every other family in the product this
 * handler declines after one indexed read — and for HIS family a bare affirmative still
 * waits on `soleOpenKind` like every other one.
 *
 * BOTH POLARITIES CLAIM. Unlike the two offers behind it, a "no" here has somewhere to go:
 * it voids the offer with its own reason and says so. An offer whose no went nowhere would
 * be one he could only get rid of by ignoring it for two days.
 */
export function founderWelcomeHandler(deps: FounderReplyDeps): DeterministicHandler {
  return {
    name: 'founder_welcome',
    resolves: new Set<OpenQuestionKind>(['founder_welcome_offer']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const resolved =
        ctx.resolved?.kind === 'founder_welcome_offer' ? ctx.resolved.polarity : null;
      // Another open question, and the resolver did not name this one. A model
      // read of a bare agreement must not text a different household.
      if (resolved === null && !soleOpenKind(await ctx.openQuestions(), 'founder_welcome_offer')) {
        return { claimed: false };
      }
      const outcome = await handleFounderWelcomeReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
          resolved,
        },
        deps,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      if (outcome.status !== 'note_sent') {
        return { claimed: true, outcome: outcome.status, reply: outcome.reply };
      }
      return {
        claimed: true,
        outcome: outcome.status,
        reply: outcome.reply,
        // Closed by the NOTE, not by the ack — `fulfilled_by` has to point at the message
        // that made good on the promise, and that message is in the other family's thread.
        // Closed AFTER the ack has actually gone, for the reason every MEM-10 writer closes
        // late: a turn that sent the note and then failed to answer must be re-drivable
        // against an offer that is still standing (the note's dedupe key makes the redrive
        // free).
        afterSend: () =>
          deps.fulfillCommitment(database, {
            familyId: ctx.familyId,
            kind: 'founder_welcome_offer',
            channelMessageId: outcome.noteChannelMessageId,
            now: ctx.now,
          }),
      };
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
      if (resolved?.polarity === 'no') return { claimed: false };
      const outcome = await handleHealthCheckpointReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
          resolved: resolved?.polarity === 'yes' ? 'booking' : null,
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
            reply: await writeConsentAsk(deps.ask, { kind: 'checkup_drafted' }),
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
 * The YES at the end of a Gmail alert — the occasion goes on the family's week.
 *
 * PLACED BETWEEN HEALTH AND PLAN, by this file's own rule: among handlers that recognise
 * the same word, the one whose wrong answer costs most goes first. A wrong reading here
 * writes a real entry on the week and materializes reminders off it — more than a plan's
 * three texts, less than filing a health checkpoint as handled (which silences a records
 * reminder for months) and far less than an approval that executes something. It cannot
 * starve the two behind it either: with no offer row the load is one indexed read and a
 * decline, which is every family that has not connected a mailbox.
 *
 * NO F14 GATE, unlike the registration handler, and the omission is the honest one: the
 * flag decides whether Hale may START a conversation, and the offer row is proof it
 * already did. Gating the answer would strand a question a parent was actually asked if
 * the flag went off between the text and the reply. With the flag off no row is ever
 * written, so the gate is the row.
 *
 * THE MODEL NAMES THE OFFER. This handler does not read the parent's words. A bare
 * "yes", a correction, or the same idea in another language is a reading from
 * `calendar-offer-read`, carried in on `ctx.resolved`. With no reading there is nothing
 * to do, and the turn continues. The receipt is written from the facts by `writeReceipt`.
 * A writer that returns nothing is `receipt_unsent`: the event is already placed (or the
 * decline is already decided) and no template is sent in its place.
 *
 * `ctx.inboundChannelMessageId` is not read. Nothing here files a fact against the
 * parent's own words — the offer row already carries its provenance — so a spoken turn,
 * which has no inbound row, would cost this handler nothing even if the kind were ever
 * added to SPOKEN_QUESTION_KINDS (it is not).
 */
export function emailAlertAddHandler(deps: {
  writeReceipt: OfferReceiptWriter;
}): DeterministicHandler {
  return {
    name: 'email_alert_add',
    resolves: new Set<OpenQuestionKind>(['email_alert_add']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const answer = ctx.resolved?.kind === 'email_alert_add' ? ctx.resolved : null;
      if (!answer) return { claimed: false };

      const outcome = await handleEmailAlertOfferReply(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        offerId: answer.questionId,
        polarity: answer.polarity,
        parentReply: ctx.body,
        now: ctx.now,
      });
      if (outcome.status === 'no_open_offer') return { claimed: false };
      const resolution = outcome.status;
      const reply = await deps.writeReceipt.write(outcome.facts);
      if (reply === null) {
        console.info(
          { status: 'receipt_unsent', outcome: resolution },
          'email alert offer: the receipt was not sent',
        );
      }
      return {
        claimed: true,
        outcome: resolution,
        reply,
        // Closed by the message that told the parent, never before it. A turn that placed
        // the event and then failed to answer must leave the offer standing so the redrive
        // finds it — the event insert is claimed against the offer, so the redrive places
        // nothing twice (the MEM-10 send-time discipline every other offer here keeps).
        // A null reply never reaches afterSend (deliver returns first), so the offer
        // stays open until a receipt actually goes out.
        afterSend: (channelMessageId) =>
          resolveEmailAlertOffer(database, {
            offerId: outcome.offerId,
            resolution,
            channelMessageId,
            now: ctx.now,
          }),
      };
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
      const resolved = ctx.resolved?.kind === 'plan_offer' && ctx.resolved.polarity === 'yes';
      if (!resolved) return { claimed: false };
      const outcome = await handlePlanYes(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          conversationId: ctx.conversationId,
          body: ctx.body,
          send: ctx.send,
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
export function sequenceReplyHandler(
  deps: SequenceReplyDeps,
  prepare: PrepareReplyDeps,
): DeterministicHandler {
  return {
    name: 'registration',
    resolves: new Set(['registration_readiness']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const preOpen = await preOpenReply(database, ctx, prepare);
      if (preOpen !== null) return preOpen;

      const outcome = await handleSequenceReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          now: ctx.now,
        },
        deps,
      );
      if (outcome.status === 'recorded') {
        return {
          claimed: true,
          outcome: outcome.status,
          reply: outcome.reply,
        };
      }
      return (await alreadyApprovedReply(database, ctx, prepare)) ?? { claimed: false };
    },
  };
}

/**
 * THE OTHER PARENT'S YES to a card this household has already approved.
 *
 * LAST IN THIS HANDLER, after every branch that could have something to record, because
 * it is the only one that acts on nothing: there is no state to write, and a turn that
 * any other branch can claim is a turn this one must not. It is also why the check is a
 * reader and not a lane — nothing here decides anything, it says what is already true.
 *
 * YES ONLY. A second parent's NO to an approved shortlist is a household disagreeing
 * with itself, which is a conversation (and possibly an undo), not an acknowledgement —
 * swallowing it with a cheerful receipt would be the worst answer available. It goes to
 * the coach exactly as it does today.
 *
 * The bare-word permission is the ordinary one, asked against the kind the word is
 * actually answering: with the card gone from the queue no approval question is open,
 * so anything ELSE outstanding makes the word ambiguous and this declines.
 */
async function alreadyApprovedReply(
  database: Database,
  ctx: HandlerContext,
  deps: PrepareReplyDeps,
): Promise<HandlerVerdict | null> {
  if (!f14EnabledFor(ctx.familyId)) return null;
  const resolved = ctx.resolved?.kind === 'approval' ? ctx.resolved : null;
  if (!resolved || resolved.polarity !== 'yes') return null;

  const approved = await deps.approvedShortlistAskedOf(
    database,
    ctx.familyId,
    ctx.parentUserId,
    ctx.now,
  );
  if (approved === null) return null;
  return { claimed: true, outcome: 'already_approved', reply: SHORTLIST_ALREADY_APPROVED_ACK };
}

/**
 * VIL-355 · the co-parent scope question's OWNER, and it claims nothing.
 *
 * The question is listed to the router (open-questions.ts) so that every OTHER handler
 * treats a bare affirmative as ambiguous while Hale is waiting to hear whether it may
 * text somebody's partner. The answer itself is read one lane earlier, by the
 * consent reader (caregiver/route.ts). A failed read texts nobody.
 *
 * WITHOUT AN OWNER the resolver could read a sentence as this kind and find nobody to
 * hand it to — `route.ts` logs that at ERROR as an impossible state, on a path that is
 * neither impossible nor an error. Declining here says the same thing truthfully: the
 * kind has an owner, and its owner does not act on a reading.
 */
export function coParentAssentHandler(): DeterministicHandler {
  return {
    name: 'co_parent_assent',
    resolves: new Set<OpenQuestionKind>(['co_parent_assent']),
    async handle(): Promise<HandlerVerdict> {
      return { claimed: false };
    },
  };
}

/**
 * The intake co-parent ask's answer: a phone number, and nothing else.
 *
 * SMS sends the locked invite. Linq tells the parent how to start the group
 * and does not text the number. A turn that is not that number is declined
 * so the name capture and the coach still hear it. A turn that is the number
 * never falls through to a model that can say an invite left when it did not.
 */
export function coParentNumberHandler(deps: CoParentNumberDeps): DeterministicHandler {
  return {
    name: 'co_parent_number',
    async handle(database, ctx): Promise<HandlerVerdict> {
      const outcome = await deliverCoParentNumberInvite(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        body: ctx.body,
        now: ctx.now,
        inboundChannelMessageId: ctx.inboundChannelMessageId,
        sendSms: deps.sendSms,
        ask: deps.ask,
      });
      if (outcome.status === 'not_pending') return { claimed: false };
      return {
        claimed: true,
        outcome: outcome.status,
        reply: outcome.reply,
        ...('templateKey' in outcome ? { templateKey: outcome.templateKey } : {}),
      };
    },
  };
}

/**
 * VIL-360 · the weekday-care question's OWNER, and it claims nothing.
 *
 * The question is listed to the router (open-questions.ts) so that every OTHER handler
 * treats a bare affirmative as ambiguous while Hale is waiting to hear how a household
 * covers its weekdays. The answer itself is read one gate later, by a deterministic
 * grammar that writes a fact and lets the coach reply — because the answer is an
 * either/or in ordinary English, not a polarity anything here could resolve.
 *
 * WITHOUT AN OWNER the resolver could read a sentence as this kind and find nobody to
 * hand it to, which `route.ts` logs at ERROR as an impossible state. Declining here says
 * the same thing truthfully: the kind has an owner, and its owner does not act on a
 * reading.
 */
export function weekdayCareHandler(): DeterministicHandler {
  return {
    name: 'weekday_care',
    resolves: new Set<OpenQuestionKind>(['weekday_care']),
    async handle(): Promise<HandlerVerdict> {
      return { claimed: false };
    },
  };
}

/**
 * VIL-365 · the empty-Saturday ask's owner, and it claims nothing.
 *
 * The question is listed so a bare YES stays ambiguous. The answer is not a
 * delivery: the held candidate is not sent from here, and a yes falls through
 * to the coach. Without an owner the resolver logs an impossible state.
 */
export function emptySaturdayHandler(): DeterministicHandler {
  return {
    name: 'empty_saturday',
    resolves: new Set<OpenQuestionKind>(['empty_saturday']),
    async handle(): Promise<HandlerVerdict> {
      return { claimed: false };
    },
  };
}

/**
 * VIL-360 · the daycare check-in's OWNER, and it claims nothing either.
 *
 * The answer is a sentence the coach reads and the coach's own memory tools persist —
 * this lane has deliberately never had an inbound surface. What the kind needs is an
 * owner, so that a resolver reading a sentence as this kind finds somebody to decline
 * rather than producing the "no handler owns this kind" ERROR on a path that is neither
 * impossible nor an error.
 */
export function daycareFollowupHandler(): DeterministicHandler {
  return {
    name: 'daycare_followup',
    resolves: new Set<OpenQuestionKind>(['daycare_followup']),
    async handle(): Promise<HandlerVerdict> {
      return { claimed: false };
    },
  };
}

/** Anything a handset made a link of. Loose on purpose: an `http://` paste is CLAIMED
 * and refused by name, rather than falling through to a coach that cannot bind it. */
const LINK_TOKEN = /https?:\/\/\S+/i;

/**
 * VIL-338 — the days BEFORE the morning, on the same handler.
 *
 * Null means "not mine, keep going", which hands the turn to the post-open check-in
 * path below and, past that, to the coach. Everything else is a verdict.
 *
 * THE ORDER IS THE PRODUCT DECISION. A resolved answer comes first because the router
 * is then on its second pass and calling exactly this handler about exactly this kind;
 * the F14 gate comes next, so a dark household reaches nothing; the ONE live pre-open
 * sequence comes next, because a pasted link means nothing without one; the link
 * outranks the bare word, because a message carrying both is a parent doing two things
 * at once and the bind is the one with a receipt worth reading.
 *
 * A BARE WORD NEEDS TWO INDEPENDENT PERMISSIONS and neither implies the other.
 * `mayClaimBareWord` says no OTHER open question could have meant it; the ask row says
 * Hale actually asked. An empty question list is vacuously unambiguous, so without the
 * second check any "yes" at all — including one answering the coach's own prose
 * question, which is never a listed kind — would land in the readiness column.
 */
async function preOpenReply(
  database: Database,
  ctx: HandlerContext,
  deps: PrepareReplyDeps,
): Promise<HandlerVerdict | null> {
  const resolved = ctx.resolved?.kind === 'registration_readiness' ? ctx.resolved : null;
  if (resolved === null && !f14EnabledFor(ctx.familyId)) return null;

  const sequence = await deps.loadPreparingSequence(database, ctx.familyId, ctx.now);
  if (sequence === null) return null;

  if (ctx.inboundChannelMessageId === null) {
    // A spoken turn: what the caller said is a transcription, and there is no message
    // row to attribute the fact to. Named rather than assumed away — no handler owning
    // one of these kinds is a spoken-turn kind, so this
    // is unreachable, and if that set ever widens the parent's answer must not be
    // filed against provenance Hale invented.
    console.error(
      { familyId: ctx.familyId, sequenceId: sequence.sequenceId },
      'registration: a pre-open answer arrived with no inbound message row - not claimed',
    );
    return null;
  }
  const inboundChannelMessageId = ctx.inboundChannelMessageId;

  if (resolved !== null) {
    const outcome = await handleReadinessAnswer(
      database,
      {
        sequence,
        answeredByUserId: ctx.parentUserId,
        ready: resolved.polarity === 'yes',
        read: 'resolver',
        confidence: resolved.confidence,
        inboundChannelMessageId,
        now: ctx.now,
      },
      deps,
    );
    return { claimed: true, outcome: outcome.status, reply: outcome.reply };
  }

  const link = LINK_TOKEN.exec(ctx.body)?.[0] ?? null;
  if (link !== null) {
    const bind = await handleCourseBind(
      database,
      {
        sequence,
        answeredByUserId: ctx.parentUserId,
        rawUrl: link,
        inboundChannelMessageId,
        now: ctx.now,
      },
      deps,
    );
    // An already-registering course belongs to VIL-337's watch and to the coach.
    if (bind.status === 'declined') return { claimed: false };

    return { claimed: true, outcome: bind.status, reply: bind.reply };
  }

  return null;
}

/**
 * Rec-morning clock and portal. Reviewed copy, no model.
 *
 * AFTER registration: "waitlisted #3" is M7's to file, and a FAQ matcher that ran
 * first would steal the report. BEFORE name capture: that handler claims a bare
 * word, which is broader than a rec-morning question.
 *
 * A watch ask is deliberately not claimed — watching is the coach's job. This
 * handler answers which morning and which login, which is the GTM miss.
 */
async function loadFamilyRecWhere(
  database: Database,
  familyId: string,
): Promise<{ city: string | null; postal: string | null } | null> {
  const [row] = await database
    .select({
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!row) return null;
  return { city: row.city, postal: row.postalCode ?? row.areaCoarse };
}

export function recMorningHandler(): DeterministicHandler {
  return {
    name: 'rec_morning',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const named = recMorningReply(ctx.body, ctx.now);
      if (named !== null) return { claimed: true, outcome: 'rec_morning', reply: named };
      if (!recMorningCouldUseWhere(ctx.body)) return { claimed: false };
      const where = await loadFamilyRecWhere(database, ctx.familyId);
      const reply = recMorningReply(ctx.body, ctx.now, where);
      if (reply === null) return { claimed: false };
      return { claimed: true, outcome: 'rec_morning', reply };
    },
  };
}

/**
 * VIL-353 · the evening check-in's answer.
 *
 * LAST OF THE REAL CLAIMERS, ahead of the canary only, and the position is the whole
 * safety argument. Every other handler in the chain claims a SHAPE — an approval word, an
 * address, a link, a rec-morning question — while this one claims a SENTENCE, which makes
 * it the broadest claimer in the product. Narrow claimers before broad ones, so it runs
 * after all of them and a parent's "done" still reaches the health lane it belongs to.
 *
 * A SENTENCE is an answer to a question, so it needs Hale to actually be holding one
 * (the ledger says so, reply.ts) AND `soleOpenKind` to say no OTHER open question could
 * have meant these words. Pace is not a keyword this handler owns. The proactive
 * decider reads it from the parent's own words.
 *
 * THE DOOR HAS TO MATCH. The question is a text; an email arriving inside the window
 * is answering something else (answeredOnTheSameChannel).
 *
 * IT REFUSES A RESOLVED ANSWER. The kind is listed to the resolver so that a bare YES
 * near it is treated as ambiguous, but its answer is not a polarity and there is
 * nothing a resolved yes-or-no could write.
 *
 * A kept note sends no fixed receipt. `reply` is null: the coach is not handed a
 * sentence this lane already filed, and Hale does not answer it with a stock line.
 */
export function eveningCheckInHandler(reader: EveningRequestReader): DeterministicHandler {
  return {
    name: 'evening_check_in',
    resolves: new Set<OpenQuestionKind>(['evening_check_in']),
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      if (ctx.resolved !== null) return { claimed: false };

      const questions = await ctx.openQuestions();
      const standing = questions.find((question) => question.kind === 'evening_check_in');
      if (!standing || standing.askedAt === null) return { claimed: false };
      if (!soleOpenKind(questions, 'evening_check_in')) return { claimed: false };

      const inboundId = ctx.inboundChannelMessageId;
      if (inboundId === null) {
        // A spoken turn: what the caller said is a transcription, and there is no message
        // row to hang the note's provenance on. Named rather than assumed away — a note
        // filed against provenance Hale invented is worse than no note.
        console.error(
          { familyId: ctx.familyId },
          'evening check-in: an answer arrived with no inbound message row - not claimed',
        );
        return { claimed: false };
      }
      if (!(await answeredOnTheSameChannel(database, standing.id, inboundId))) {
        return { claimed: false };
      }

      const outcome = await handleEveningCheckInReply(
        database,
        {
          familyId: ctx.familyId,
          parentUserId: ctx.parentUserId,
          body: ctx.body,
          askedAt: standing.askedAt,
          timeZone: await readFamilyTimezone(database, ctx.familyId),
          inboundChannelMessageId: inboundId,
          now: ctx.now,
        },
        reader,
      );
      if (outcome.status === 'declined_to_claim') return { claimed: false };
      return { claimed: true, outcome: outcome.status, reply: null };
    },
  };
}
