import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { noteRegistrationRunFailed, noteTaskCompleted } from '~/lib/analytics/product-hooks';
import { isParentHeld } from '~/lib/channel/intake/opt-out-hold';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { isUuid } from '~/lib/channel/mid-activity/claim';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import type { Asked } from '~/lib/channel/router/open-questions';
import {
  type AskPlace,
  SIGNUP_ASK_BACK_QUESTION,
  loadLiveAsks,
  stoppedTurn,
  wordsNameAsk,
} from './asks';
import { redactSignupAudit } from './audit';
import { authorizeSignup } from './authorize';
import {
  BrowserUseEngineThrew,
  type BrowserUseSignupResult,
  PAYMENT_RUN_MAX_COST_USD,
  SIGNUP_RUN_MAX_COST_USD,
} from './browser-use/engine';
import { browserUseSignupEnabled, browserUseSignupPaymentEnabled } from './browser-use/flag';
import { browserUseProxyFor } from './browser-use/proxy';
import {
  type BrowserUseSignupRunner,
  browserUseSignupRunnerFromEnv,
  signupWalletFromEnv,
} from './browser-use/runner';
import { loadProviderSession, recordBrowserUseProfile } from './browser-use/vault';
import { bookingConnectors } from './connectors/registry';
import { connectorBookingSlots } from './connectors/slots';
import {
  ensureSignupConsent,
  fieldsPreparedToType,
  signupProviderHost,
  typedOutsideGrant,
} from './consent';
import type { ShareableSignupField } from './consent';
import {
  type SignupConsentReader,
  type SignupConsentReading,
  createSignupConsentReader,
} from './consent-reader';
import { type ReportDoor, chooseReportDoor } from './door';
import { authorizedSignupEnabled } from './flag';
import { type RushSignal, rushOpensAt } from './forms/rush';
import { collapseSignupFact } from './handoff';
import { inspectRegistrationPage } from './inspect';
import { LINK_SPEND_CEILING_CENTS } from './link/client';
import type { SignupPaymentWallet, SignupWalletSkipped, SignupWalletSource } from './link/wallet';
import {
  type SignupOutcomeFacts,
  type SignupOutcomeWriter,
  createSignupOutcomeWriter,
} from './outcome-reply';
import { type InfoPackSlot, signupInfoPack } from './pack';
import { namesFacts } from './parent-quote';
import { type PlanTurnDeps, runPlanAsk } from './plan/conversation';
import { untrustedActivityLabel } from './plan/reader';
import { type BookingConnector, bookingRoute } from './providers';
import { type GroupSignupDelivery, sendSignupToGroup } from './report';
import type { SignupRuntimeAcquire, SignupRuntimeSkipped } from './runtime/types';
import {
  type PendingSignupOffer,
  type SendStamp,
  askStamp,
  loadBusy,
  loadSignupIdentity,
  markOffer,
  recordBrowserUseCost,
  reserveBrowserUseAllowance,
} from './store';
import type { SignupBrowser, SignupIdentity, SignupPage, SignupStopReason } from './types';
import { registrationUrlAllowed } from './url';

export interface SignupRunInput {
  familyId: string;
  parentUserId: string;
  body: string;
  inboundChannelMessageId: string | null;
  /** True when this turn is already inside a thread the parent opened. */
  existingThread: boolean;
  now: Date;
  /** The door's opt-out read could not read this text (`ChannelTurn.optOutUnread`). */
  optOutUnread?: boolean;
  /**
   * The parent's open questions on the router's list (`HandlerContext.openQuestions`). One
   * asked after Hale's last text about their sign-up asks takes a bare yes or no instead
   * (VIL-302, `loadLiveAsks`). Absent: no list was read for this turn, and none is ranked.
   */
  openQuestions?: readonly Asked[];
}

export interface SignupRunDeps {
  /** Reads whether the parent said to sign up. Undefined uses the reply model. */
  consentReader?: SignupConsentReader;
  /** Writes the parent's reply from the structured outcome. Undefined uses the reply model. */
  outcomeWriter?: SignupOutcomeWriter;
  /** VIL-558 · the day-before plan read and its replies. Undefined uses the reply model. */
  planReader?: PlanTurnDeps['planReader'];
  planWriter?: PlanTurnDeps['planWriter'];
  mismatchReader?: PlanTurnDeps['mismatchReader'];
  sendProviderEmail?: PlanTurnDeps['sendProviderEmail'];
  /** True when this sender holds a group seat that may not authorize a sign-up. */
  declineSeat?: () => Promise<boolean>;
  /** Undefined loads Playwright. Null means the browser is absent. */
  browser?: SignupBrowser | null;
  /**
   * Defaults to `bookingConnectors()`. A connector failure does not fall
   * through to the browser.
   */
  connectors?: readonly BookingConnector[];
  deliverGroup?: (input: GroupSignupDelivery) => Promise<'sent' | 'failed' | 'already_sent'>;
  /**
   * Browser Use engine (T8), used only when BROWSER_USE_SIGNUP_ENABLED is
   * exactly `true`. Undefined builds it from env; null means it is absent, and
   * that absence is returned as `not_configured`.
   */
  browserUseSignup?: BrowserUseSignupRunner | null;
  /** Each parent's own Link wallet. Undefined reads the env; null names it absent. */
  paymentWallet?: SignupWalletSource | null;
  /** Rule #7. Undefined uses `signupSpendingCap`: the approved price, at most $500. */
  checkSpendingCap?: (
    familyId: string,
    cost: { amountUsd: number; category: string },
  ) => Promise<{ ok: boolean; reason: string }>;
}

export interface SignupRunResult {
  /** Present when a rush signal handed the sign-up to the parent. */
  rush?: RushHandoff | null;
  claimed: boolean;
  outcome: string;
  reply: string | null;
  /** Separate Linq sends, one bubble each. When set, the handler sends these instead of `reply`. */
  replies?: string[];
  deliverOnThread: boolean;
  /**
   * For the router to bracket the send of the reply on the thread (`askStamp`): the ask it
   * speaks to becomes the one Hale asked this parent last, so their next bare yes or no
   * answers it.
   */
  stamp?: SendStamp;
  /**
   * Set on the Browser Use path. Hale's AI writes the parent message from it;
   * this module has no fixed copy for it. `liveViewUrl` goes to the parent only.
   */
  browserUse?: BrowserUseHandoff;
  /** The turn was claimed and nothing was sent because no acceptable reply was written. */
  unsent?: 'reply_unwritten';
  /**
   * Browser Use path: Hale could not tell whether the yes came 1:1 or in a group, so the
   * reply carried only the public registration link (no pack, no live view).
   */
  withheld?: 'thread_unresolved';
}

export type BrowserUseHandoff =
  | BrowserUseSignupResult
  | {
      outcome: 'error' | 'needs_login';
      detail: 'not_configured' | 'no_provider_session' | 'engine_threw' | 'spend_reserve_reached';
      liveViewUrl: null;
      checkoutUrl: null;
      holdExpiresAt: null;
      cartTotalCents: null;
      confirmationNumber: null;
      opensAt: null;
      amountChargedCents: null;
      /** Set only on engine_threw, from the ids the engine had created. */
      runId: string | null;
      sessionId: string | null;
      costUsd: null;
      sessionCostUsd: string | null;
      browserId: string | null;
    };

const UNCLAIMED: SignupRunResult = {
  claimed: false,
  outcome: 'not_claimed',
  reply: null,
  deliverOnThread: false,
};

/**
 * Parent-authorized booking for anything a parent needs signed up. A connector
 * from the registry runs first when one matches the host. A connector failure
 * returns connector_failed and does not open the browser. Otherwise the sandbox
 * browser opens that provider's own page and follows it until it submits or
 * a page repeats unchanged.
 * Any provider host may take the browser. A rush signal (queue,
 * resident or identity check, timed open-at) hands back with no submit and a
 * `rush` handoff: the open time, the link, and the parent's prefilled info. The browser opens only after the gate accepts one activity, one
 * session, and the price, the result has a door, and
 * a consent row from this yes covers every slot about to be typed or packed.
 */
export async function runAuthorizedSignup(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps = {},
): Promise<SignupRunResult> {
  if (!authorizedSignupEnabled()) return { ...UNCLAIMED, outcome: 'flag_off' };
  const planDeps: PlanTurnDeps = {
    planReader: deps.planReader,
    planWriter: deps.planWriter,
    mismatchReader: deps.mismatchReader,
    declineSeat: deps.declineSeat,
    sendProviderEmail:
      deps.sendProviderEmail ??
      (async (payload) => {
        const { createGmailEmailSender } = await import('~/lib/integrations/gmail-send-service');
        await createGmailEmailSender(database)(
          { to: payload.to, subject: payload.subject, body: payload.body },
          { familyId: payload.familyId, actorUserId: payload.actorUserId },
        );
      }),
  };
  // This parent's asks, newest first, plan and one-shot alike: each is read by its own lane,
  // and a message one ask's reader finds unrelated goes on to the next. No ask left:
  // someone else's.
  const asks = await loadLiveAsks(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    openQuestions: input.openQuestions ?? [],
  });
  // A stop is the opt-out's, read at the door before any turn reaches here. A text of theirs
  // the opt-out read could not read may be one, so until it is read it moves none of their
  // asks: this text, as the turn carries it (the door's hold row may not have been written),
  // or an earlier one still held (opt-out-hold.ts).
  if (
    asks.length > 0 &&
    (input.optOutUnread === true || (await isParentHeld(database, input.parentUserId)))
  ) {
    console.warn(
      {
        outcome: 'signup_opt_out_unread',
        asks: asks.length,
        thisText: input.optOutUnread === true,
      },
      'signup asks: a text of theirs may be an unread stop - no ask moves',
    );
    return { ...UNCLAIMED, outcome: 'opt_out_unread' };
  }
  for (const ask of asks) {
    const turn =
      ask.lane === 'plan'
        ? await runPlanAsk(database, input, planDeps, ask.plan, ask.place)
        : await runOneShotAsk(
            database,
            input,
            deps,
            ask.offer,
            ask.place,
            asks.some((other) => other !== ask && wordsNameAsk(input.body, other)),
          );
    if (turn !== 'unrelated') return turn;
  }
  return UNCLAIMED;
}

/**
 * One pending ask Hale made this parent with no open ahead: the consent read, then the
 * booking. `unrelated` hands the message to the next ask. A yes or a no moves this ask only
 * when Hale asked the parent about it last, or when it is the sign-up ask Hale asked about
 * last and their words name it while an open question outranks it (`AskPlace.laneNewest`).
 * Otherwise words that carry its program's name or its site, in whole words, only make Hale
 * ask about it; once that question went out it is the ask asked last, and the parent's next
 * answer is its. A yes or no in no ask's words stops the
 * turn, and so does one whose words name another of their asks (`namesAnother`) and not
 * this one: it is not this ask's, and it is not handed on. A reading that failed stops the
 * turn. A question back comes only from the ask Hale asked last or one their words name;
 * any other passes the message on.
 */
async function runOneShotAsk(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  offer: PendingSignupOffer,
  place: AskPlace,
  namesAnother: boolean,
): Promise<SignupRunResult | 'unrelated'> {
  const reader = deps.consentReader ?? defaultConsentReader();
  const reading: SignupConsentReading | null = await reader.read({ text: input.body, offer });
  // Unreadable (no model, model failure) is not consent and does not claim the message.
  if (!reading) return stoppedTurn('signup_unread', { offerId: offer.id, status: 'pending' });
  if (reading.verdict === 'unrelated') return 'unrelated';
  const named = namesFacts(input.body, {
    activity: untrustedActivityLabel(offer.activityLabel),
    host: offer.providerHost,
  });
  if (namesAnother && !named) {
    console.info(
      { offerId: offer.id, verdict: reading.verdict },
      'signup asks: words name another ask',
    );
    if (reading.verdict === 'unclear') return 'unrelated';
    return stoppedTurn('signup_unnamed', { offerId: offer.id, status: 'pending' });
  }
  if (reading.verdict === 'unclear' && !place.newest && !named) return 'unrelated';
  // Named in whole words while only an open question outranks it: the words bind it.
  const binds = place.newest || (place.laneNewest && named);
  if (reading.verdict === 'consent' || reading.verdict === 'decline') {
    if (!place.newest && !named) {
      return stoppedTurn('signup_unnamed', { offerId: offer.id, status: 'pending' });
    }
    if (deps.declineSeat && (await deps.declineSeat())) {
      return {
        claimed: true,
        outcome: 'group_member_not_authorized',
        reply: null,
        deliverOnThread: false,
      };
    }
  }
  const door = await reportDoor(database, input);

  const allowed = registrationUrlAllowed(offer.registrationUrl);
  const host = allowed.ok ? new URL(allowed.href).hostname : null;
  if (door.kind === 'held') {
    await writeAudit(database, input, offer.id, {
      step: 'door',
      reason: 'would_initiate_1_1',
      host,
    });
    return {
      claimed: true,
      outcome: 'would_initiate_1_1',
      reply: null,
      deliverOnThread: false,
    };
  }

  if (reading.verdict === 'unclear' || !binds) {
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'clarify',
      reason: null,
      link: '',
      prefilled: [],
      host,
      question: reading.verdict === 'unclear' ? reading.question : SIGNUP_ASK_BACK_QUESTION,
    });
  }
  if (reading.verdict === 'decline') {
    await markFromPending(database, input, offer.id, null);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'declined',
      reason: null,
      link: '',
      prefilled: [],
      host,
    });
  }

  const decision = authorizeSignup({
    reading,
    offer,
    busy: await loadBusy(database, input.familyId),
  });
  if (!decision.ok) {
    await markFromPending(database, input, offer.id, null);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: decision.reason,
      reason: decision.reason,
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  }

  const identity = await loadSignupIdentity(database, {
    familyId: input.familyId,
    childId: offer.childId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  if (!identity) {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'missing_detail',
      reason: 'missing_detail',
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  }
  if (!allowed.ok) {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'url_refused',
      reason: 'url_refused',
      link: '',
      prefilled: [],
      host: null,
    });
  }

  const route = bookingRoute(allowed.href, deps.connectors ?? bookingConnectors());
  const session = offer.sessions.find((item) => item.id === decision.sessionId);
  if (!session) {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'session_not_offered',
      reason: 'session_not_offered',
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  }
  const providerHost = signupProviderHost(new URL(allowed.href).hostname);
  const typedFields = fieldsPreparedToType(identity, session);
  const consent = await ensureSignupConsent(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    messageId: input.inboundChannelMessageId,
    activityKey: decision.activityKey,
    providerHost,
    fieldsAllowed: typedFields,
    now: input.now,
  });
  if (!consent.ok) {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: consent.reason,
      reason: consent.reason,
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  }
  const claimed = await markOffer(database, {
    offerId: offer.id,
    familyId: input.familyId,
    from: 'pending',
    status: 'submitting',
    sessionId: decision.sessionId,
    messageId: input.inboundChannelMessageId,
    now: input.now,
  });
  if (!claimed) {
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'already_in_progress',
      reason: 'already_in_progress',
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  }

  await writeAudit(database, input, offer.id, {
    step: 'authorized',
    activityKey: decision.activityKey,
    sessionId: decision.sessionId,
    route: route.kind,
    connector: route.kind === 'connector' ? route.connector.id : null,
    host,
  });

  if (browserUseSignupEnabled()) {
    return runBrowserUseBranch(database, input, deps, {
      door,
      offerId: offer.id,
      href: allowed.href,
      providerHost,
      host,
      identity,
      session,
      fieldsAllowed: consent.fieldsAllowed,
      approvedPriceCents: offer.approvedPriceCents,
    });
  }

  if (route.kind === 'connector') {
    const slots = connectorBookingSlots({
      identity,
      session,
      fieldsAllowed: consent.fieldsAllowed,
    });
    if (!slots.ok) {
      await finish(database, input, offer.id, 'handed_back');
      return replyFor(database, input, deps, door, {
        offerId: offer.id,
        outcome: slots.reason,
        reason: slots.reason,
        link: offer.registrationUrl,
        prefilled: [],
        host,
      });
    }
    try {
      const booked = await route.connector.book({
        url: allowed.href,
        activityKey: decision.activityKey,
        sessionId: decision.sessionId,
        approvedPriceCents: offer.approvedPriceCents,
        slots: slots.slots,
      });
      if (!booked.ok) {
        await finish(database, input, offer.id, 'handed_back');
        return replyFor(database, input, deps, door, {
          offerId: offer.id,
          outcome: booked.reason,
          reason: booked.reason,
          link: offer.registrationUrl,
          prefilled: [],
          host,
        });
      }
      await finish(database, input, offer.id, 'completed');
      await writeAudit(database, input, offer.id, {
        step: 'completed',
        activityKey: decision.activityKey,
        sessionId: decision.sessionId,
        route: 'connector',
        connector: route.connector.id,
        host,
      });
      return replyFor(database, input, deps, door, {
        offerId: offer.id,
        outcome: 'completed',
        reason: null,
        link: offer.registrationUrl,
        prefilled: [],
        host,
        sessionLabel: labelFor(offer, decision.sessionId),
        confirmation: { kind: 'connector', connector: route.connector.id },
      });
    } catch {
      await finish(database, input, offer.id, 'handed_back');
      console.warn(
        { familyId: input.familyId, offerId: offer.id, connector: route.connector.id },
        'authorized signup: connector stopped',
      );
      return replyFor(database, input, deps, door, {
        offerId: offer.id,
        outcome: 'connector_failed',
        reason: 'connector_failed',
        link: offer.registrationUrl,
        prefilled: [],
        host,
      });
    }
  }

  const acquired = await resolveBrowser(deps);
  if (!acquired.browser) {
    await finish(database, input, offer.id, 'handed_back');
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'browser_unavailable',
      reason: 'browser_unavailable',
      link: offer.registrationUrl,
      prefilled: [],
      host,
      runtimeSkipped: acquired.skipped,
    });
  }
  const browser = acquired.browser;

  let page: SignupPage | null = null;
  const filled: string[] = [];
  try {
    page = await browser.open(allowed.href);
    const origin = new URL(allowed.href).origin;
    const chosen = offer.sessions.find((item) => item.id === decision.sessionId);
    let sessionSelected = false;
    let previous: string | null = null;
    for (;;) {
      const snapshot = await page.snapshot();
      const fingerprint = JSON.stringify([snapshot.href, snapshot.formText, snapshot.controls]);
      if (fingerprint === previous) break;
      previous = fingerprint;
      const inspection = inspectRegistrationPage({
        snapshot,
        identity,
        sessionId: decision.sessionId,
        sessionStartsAt: chosen?.startsAt ?? null,
        partySize: chosen?.partySize ?? null,
        seatingNote: chosen?.seatingNote ?? null,
        approvedPriceCents: offer.approvedPriceCents,
        expectedOrigin: origin,
        sessionSelected,
      });
      if (inspection.action === 'stop') {
        await finish(database, input, offer.id, 'handed_back');
        return replyFor(database, input, deps, door, {
          offerId: offer.id,
          outcome: inspection.reason,
          reason: inspection.reason,
          link: offer.registrationUrl,
          prefilled: filled,
          host,
          rush: rushHandoff(inspection.reason, snapshot.formText, offer.registrationUrl, identity),
        });
      }
      if (
        typedOutsideGrant(
          inspection.fills.map((item) => item.slot),
          consent.fieldsAllowed,
        )
      ) {
        await finish(database, input, offer.id, 'handed_back');
        return replyFor(database, input, deps, door, {
          offerId: offer.id,
          outcome: 'consent_short',
          reason: 'consent_short',
          link: offer.registrationUrl,
          prefilled: filled,
          host,
        });
      }
      for (const fill of inspection.fills) {
        if (fill.control === 'select') await page.select(fill.name, fill.value);
        else await page.fill(fill.name, fill.value);
        if (fill.slot === 'session') sessionSelected = true;
      }
      filled.push(...inspection.fills.map((item) => item.slot));
      if (inspection.action === 'submit') {
        await page.submit();
        const after = await page.snapshot();
        if (!after.confirmed) {
          await finish(database, input, offer.id, 'handed_back');
          return replyFor(database, input, deps, door, {
            offerId: offer.id,
            outcome: 'unconfirmed',
            reason: 'unconfirmed',
            link: offer.registrationUrl,
            prefilled: filled,
            host,
          });
        }
        await finish(database, input, offer.id, 'completed');
        await writeAudit(database, input, offer.id, {
          step: 'completed',
          activityKey: decision.activityKey,
          sessionId: decision.sessionId,
          fieldsFilled: filled,
          host,
        });
        return replyFor(database, input, deps, door, {
          offerId: offer.id,
          outcome: 'completed',
          reason: null,
          link: offer.registrationUrl,
          prefilled: filled,
          host,
          sessionLabel: labelFor(offer, decision.sessionId),
          confirmation: { kind: 'page' },
        });
      }
      await page.continue();
    }
    await finish(database, input, offer.id, 'handed_back');
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'unconfirmed',
      reason: 'unconfirmed',
      link: offer.registrationUrl,
      prefilled: filled,
      host,
    });
  } catch (err) {
    await finish(database, input, offer.id, 'handed_back');
    const reason: SignupStopReason =
      err instanceof Error && err.message === 'url_refused' ? 'url_refused' : 'browser_unavailable';
    console.warn(
      { familyId: input.familyId, offerId: offer.id, reason },
      'authorized signup: browser stopped',
    );
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: reason,
      reason,
      link: offer.registrationUrl,
      prefilled: [],
      host,
    });
  } finally {
    await page?.close();
  }
}

/** Barton's production reserve for Browser Use registrations (10/25): $25 total. */
export const BROWSER_USE_REGISTRATION_RESERVE_USD = 25;
/**
 * Held per run: the signup and payment agent caps plus $1 for what those caps
 * leave out (browser time incl. the 15-minute checkout keep-alive, proxy,
 * search and profile seeding).
 */
export const BROWSER_USE_RUN_ALLOWANCE_USD = SIGNUP_RUN_MAX_COST_USD + PAYMENT_RUN_MAX_COST_USD + 1;

function browserUseAbsent(
  outcome: 'error' | 'needs_login',
  detail: 'not_configured' | 'no_provider_session' | 'engine_threw' | 'spend_reserve_reached',
): BrowserUseHandoff {
  return {
    outcome,
    detail,
    liveViewUrl: null,
    checkoutUrl: null,
    holdExpiresAt: null,
    cartTotalCents: null,
    confirmationNumber: null,
    opensAt: null,
    amountChargedCents: null,
    runId: null,
    sessionId: null,
    costUsd: null,
    sessionCostUsd: null,
    browserId: null,
  };
}

/**
 * T8 — the parent's yes, the session, the price and the consent grant were all
 * checked above. Browser Use drives the provider's site through the saved
 * session to checkout. With the parent's own Link wallet and the spending cap
 * passed, it pays the exact total once that parent approves in Link; otherwise,
 * or when approval times out, the parent pays on the live browser. A rush
 * page comes back as a handoff. Every outcome ends through `replyFor`, so the
 * parent hears it in the reply model's words, or the non-send is named.
 */
async function runBrowserUseBranch(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  ctx: {
    door: ReportDoor;
    offerId: string;
    href: string;
    providerHost: string;
    host: string | null;
    identity: Parameters<BrowserUseSignupRunner['run']>[0]['identity'];
    session: {
      label: string;
      startsAt: string;
      endsAt: string;
      partySize?: number | null;
      seatingNote?: string | null;
    };
    fieldsAllowed: readonly ShareableSignupField[];
    approvedPriceCents: number | null;
  },
): Promise<SignupRunResult> {
  let allowanceHeld = false;
  // A throw that does not say which session it had created may have started one:
  // its hold stays until a real cost replaces it.
  let sessionMayExist = false;
  const done = async (
    raw: BrowserUseHandoff,
    paymentSkipped: SignupPaymentSkipped | null = null,
  ): Promise<SignupRunResult> => {
    // Completed only with a captured confirmation number. engine.ts already hands back
    // 'unconfirmed'; this keeps any runner from reporting success without one.
    const handoff: BrowserUseHandoff =
      raw.outcome === 'completed' && raw.confirmationNumber === null
        ? { ...raw, outcome: 'needs_human', detail: 'unconfirmed' }
        : raw;
    const paid = handoff.outcome === 'completed';
    await finish(database, input, ctx.offerId, paid ? 'completed' : 'handed_back');
    if (handoff.outcome === 'error') {
      noteRegistrationRunFailed({
        familyId: input.familyId,
        providerDomain: ctx.host ?? ctx.providerHost,
        stage: handoff.detail ?? 'error',
        source: 'signup',
      });
    }
    // No Browser Use session ever started (setup failed or the engine threw
    // before a run): release the held allowance. A started session keeps its
    // hold until its real cost replaces it.
    const settledCostUsd =
      handoff.sessionCostUsd ??
      (allowanceHeld && !sessionMayExist && handoff.sessionId === null && handoff.runId === null
        ? '0'
        : null);
    if (settledCostUsd !== null) {
      await recordBrowserUseCost(database, {
        offerId: ctx.offerId,
        familyId: input.familyId,
        sessionCostUsd: settledCostUsd,
        now: input.now,
      });
    }
    const thread = await yesThread(database, input);
    const withheld = thread === 'unresolved' ? { withheld: 'thread_unresolved' as const } : {};
    await writeAudit(database, input, ctx.offerId, {
      step: 'browser_use',
      outcome: handoff.outcome,
      detail: handoff.detail,
      runId: handoff.runId,
      holdExpiresAt: handoff.holdExpiresAt?.toISOString() ?? null,
      cartTotalCents: handoff.cartTotalCents,
      amountChargedCents: handoff.amountChargedCents,
      confirmed: handoff.confirmationNumber !== null,
      paymentSkipped,
      rushOpensAt: handoff.opensAt,
      costUsd: handoff.costUsd,
      sessionCostUsd: handoff.sessionCostUsd,
      host: ctx.host,
      ...withheld,
    });
    const rush: RushHandoff | null =
      handoff.outcome === 'rush'
        ? {
            signal: handoff.detail === 'timed_open' ? 'timed_open' : 'waiting_room',
            opensAt: handoff.opensAt,
            link: ctx.href,
            prefill: signupInfoPack(ctx.identity),
          }
        : null;
    if (thread === 'unresolved') {
      console.info(
        { outcome: 'thread_unresolved' },
        'authorized signup: yes thread unresolved, details withheld',
      );
    }
    const facts = browserUseReplyFacts(handoff, ctx, thread === 'private', rush);
    // A live view or the pack goes back on the 1:1 thread the yes came from, never
    // into the family's claimed group.
    const door =
      facts.linkIs === 'live_browser' || (facts.pack?.length ?? 0) > 0
        ? chooseReportDoor({ groupChatId: null, existingThread: input.existingThread })
        : ctx.door;
    return {
      ...(await replyFor(database, input, deps, door, facts)),
      browserUse: handoff,
      ...withheld,
    };
  };

  const runner =
    deps.browserUseSignup !== undefined
      ? deps.browserUseSignup
      : browserUseSignupRunnerFromEnv().runner;
  if (!runner) {
    console.warn(
      { familyId: input.familyId, offerId: ctx.offerId, skipped: 'not_configured' },
      'authorized signup: browser use engine not configured',
    );
    return done(browserUseAbsent('error', 'not_configured'));
  }
  const stored = await loadProviderSession(database, {
    familyId: input.familyId,
    providerHost: ctx.providerHost,
    now: input.now,
  });
  if (!stored) return done(browserUseAbsent('needs_login', 'no_provider_session'));

  const payment = await signupPayment(database, input, deps, ctx.approvedPriceCents);
  if (payment.skipped && payment.skipped !== 'payment_flag_off') {
    console.warn(
      { familyId: input.familyId, offerId: ctx.offerId, paymentSkipped: payment.skipped },
      'authorized signup: agent payment skipped, stopping at checkout',
    );
  }

  // Production reserve for Browser Use registrations. The run's worst-case
  // allowance is held on this offer before it starts, under a lock, and
  // replaced by the real session cost when the browser stops. A live-view
  // handoff keeps the allowance, so total spend never passes the reserve.
  const reserved = await reserveBrowserUseAllowance(database, {
    offerId: ctx.offerId,
    familyId: input.familyId,
    allowanceUsd: BROWSER_USE_RUN_ALLOWANCE_USD,
    reserveUsd: BROWSER_USE_REGISTRATION_RESERVE_USD,
    now: input.now,
  });
  if (!reserved.ok) {
    console.warn(
      { familyId: input.familyId, offerId: ctx.offerId, spentUsd: reserved.spentUsd },
      'authorized signup: browser use registration reserve reached',
    );
    return done(browserUseAbsent('error', 'spend_reserve_reached'), payment.skipped);
  }
  allowanceHeld = true;

  let result: BrowserUseSignupResult;
  try {
    result = await runner.run({
      correlationId: ctx.offerId,
      registrationUrl: ctx.href,
      identity: ctx.identity,
      fieldsAllowed: ctx.fieldsAllowed,
      session: ctx.session,
      approvedPriceCents: ctx.approvedPriceCents,
      payment: payment.wallet,
      providerSession: {
        storageState: stored.storageState,
        browserUseProfileId: stored.browserUseProfileId,
      },
      onProfileCreated: (profileId) =>
        recordBrowserUseProfile(database, { sessionRowId: stored.id, profileId }),
      proxyCountryCode: browserUseProxyFor(ctx.providerHost),
    });
  } catch (err) {
    console.warn(
      {
        familyId: input.familyId,
        offerId: ctx.offerId,
        error: err instanceof Error ? err.name : 'unknown',
      },
      'authorized signup: browser use engine threw',
    );
    if (err instanceof BrowserUseEngineThrew) {
      // The engine reports the ids it had created; a started session keeps its hold.
      return done(
        {
          ...browserUseAbsent('error', 'engine_threw'),
          runId: err.runId,
          sessionId: err.sessionId,
          browserId: err.browserId,
          sessionCostUsd: err.sessionCostUsd,
        },
        payment.skipped,
      );
    }
    sessionMayExist = true;
    return done(browserUseAbsent('error', 'engine_threw'), payment.skipped);
  }
  return done(result, payment.skipped);
}

export type SignupPaymentSkipped =
  | 'payment_flag_off'
  | 'no_approved_price'
  | 'spending_cap'
  | 'not_configured'
  | SignupWalletSkipped;

/** Rule #7 for sign-ups: the cap is the price the parent approved, never above $500. */
export function signupSpendingCap(approvedPriceCents: number) {
  return async (
    _familyId: string,
    cost: { amountUsd: number; category: string },
  ): Promise<{ ok: boolean; reason: string }> => {
    const cents = Math.round(cost.amountUsd * 100);
    if (cents > approvedPriceCents) {
      return {
        ok: false,
        reason: `amount ${cents} exceeds the approved price ${approvedPriceCents}`,
      };
    }
    if (cents > LINK_SPEND_CEILING_CENTS) {
      return {
        ok: false,
        reason: `amount ${cents} exceeds the ${LINK_SPEND_CEILING_CENTS} ceiling`,
      };
    }
    return { ok: true, reason: 'within the approved price and the sign-up ceiling' };
  };
}

/** Rule #7: the spending cap runs before any wallet reaches the agent. */
async function signupPayment(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  approvedPriceCents: number | null,
): Promise<{ wallet: SignupPaymentWallet | null; skipped: SignupPaymentSkipped | null }> {
  if (!browserUseSignupPaymentEnabled()) return { wallet: null, skipped: 'payment_flag_off' };
  if (approvedPriceCents === null) return { wallet: null, skipped: 'no_approved_price' };
  const check = deps.checkSpendingCap ?? signupSpendingCap(approvedPriceCents);
  const verdict = await check(input.familyId, {
    amountUsd: approvedPriceCents / 100,
    category: 'registration',
  });
  if (!verdict.ok) return { wallet: null, skipped: 'spending_cap' };
  const source =
    deps.paymentWallet !== undefined ? deps.paymentWallet : signupWalletFromEnv(database).source;
  if (!source) return { wallet: null, skipped: 'not_configured' };
  const lookup = await source.forParent({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  return lookup.wallet
    ? { wallet: lookup.wallet, skipped: null }
    : { wallet: null, skipped: lookup.skipped };
}

async function resolveBrowser(deps: SignupRunDeps): Promise<SignupRuntimeAcquire> {
  if (deps.browser !== undefined) {
    return { runtime: 'local', browser: deps.browser, skipped: null, missing: [] };
  }
  const { acquireSignupBrowser } = await import('./runtime/acquire');
  return acquireSignupBrowser();
}

async function reportDoor(database: Database, input: SignupRunInput): Promise<ReportDoor> {
  const target = await familyOutboundTarget(database, input.familyId);
  return chooseReportDoor({
    groupChatId: target.channel === 'group' ? target.chatId : null,
    existingThread: input.existingThread,
  });
}

async function markFromPending(
  database: Database,
  input: SignupRunInput,
  offerId: string,
  sessionId: string | null,
): Promise<void> {
  await markOffer(database, {
    offerId,
    familyId: input.familyId,
    from: 'pending',
    status: 'handed_back',
    sessionId,
    messageId: input.inboundChannelMessageId,
    now: input.now,
  });
}

async function finish(
  database: Database,
  input: SignupRunInput,
  offerId: string,
  status: 'completed' | 'handed_back',
): Promise<void> {
  await markOffer(database, {
    offerId,
    familyId: input.familyId,
    from: 'submitting',
    status,
    now: input.now,
  });
  if (status === 'completed') {
    noteTaskCompleted({ familyId: input.familyId, type: 'registration', source: 'browser_use' });
  }
}

function labelFor(offer: { sessions: { id: string; label: string }[] }, sessionId: string): string {
  return offer.sessions.find((item) => item.id === sessionId)?.label ?? '';
}

interface ReplyFacts {
  offerId: string;
  outcome: string;
  reason: SignupStopReason | BrowserUseHandoff['detail'] | null;
  link: string;
  /** Browser Use only. Elsewhere a set link is the registration page. */
  linkIs?: SignupOutcomeFacts['linkIs'];
  /** Browser Use live view only. */
  holdMinutes?: number | null;
  /** Browser Use only: the details the parent fills the form with, after a 1:1 yes. */
  pack?: InfoPackSlot[];
  /** Browser Use only: the yes came from the group, or from a thread Hale cannot place. */
  inGroup?: boolean;
  prefilled: string[];
  host: string | null;
  /** Session label for the completed line. */
  sessionLabel?: string;
  /** Named reason the runtime handed back no browser. Absent when a browser ran. */
  runtimeSkipped?: SignupRuntimeSkipped | null;
  /** Set when a rush signal stopped the run. Prefill values stay out of the audit. */
  rush?: RushHandoff | null;
  /** Evidence of a booking. `completed` without it is reported as `unconfirmed`. */
  confirmation?: SignupConfirmation;
  /** The consent read's clarifying question, for `clarify`. */
  question?: string;
}

/**
 * What proves a booking: the provider's confirmation page, its booking API saying
 * booked, or a confirmation number the Browser Use run captured.
 */
export type SignupConfirmation =
  | { kind: 'page' }
  | { kind: 'connector'; connector: string }
  | { kind: 'confirmation_number' };

/**
 * Never claim success without a confirmation. The only way to report
 * `completed` is to carry the evidence; anything else is `unconfirmed`.
 */
export function confirmedOutcome(facts: { outcome: string; confirmation?: SignupConfirmation }): {
  outcome: string;
  confirmed: boolean;
} {
  if (facts.outcome !== 'completed') return { outcome: facts.outcome, confirmed: false };
  if (!facts.confirmation) return { outcome: 'unconfirmed', confirmed: false };
  return { outcome: 'completed', confirmed: true };
}

let cachedConsentReader: SignupConsentReader | null = null;
let cachedOutcomeWriter: SignupOutcomeWriter | null = null;

function defaultConsentReader(): SignupConsentReader {
  cachedConsentReader ??= createSignupConsentReader(() => resolveReplyClient(undefined));
  return cachedConsentReader;
}

function defaultOutcomeWriter(): SignupOutcomeWriter {
  cachedOutcomeWriter ??= createSignupOutcomeWriter(() => resolveReplyClient(undefined));
  return cachedOutcomeWriter;
}

/** A rush sign-up is the parent's: hand over the open time, the link and the prefill. */
export interface RushHandoff {
  signal: RushSignal;
  opensAt: string | null;
  link: string;
  prefill: InfoPackSlot[];
}

const RUSH_STOPS: ReadonlySet<string> = new Set<RushSignal>([
  'waiting_room',
  'resident_verification',
  'timed_open',
]);

function rushHandoff(
  reason: SignupStopReason,
  pageText: string,
  link: string,
  identity: SignupIdentity,
): RushHandoff | null {
  if (!RUSH_STOPS.has(reason)) return null;
  return {
    signal: reason as RushSignal,
    opensAt: rushOpensAt(pageText),
    link,
    prefill: signupInfoPack(identity),
  };
}

type YesThread = 'private' | 'group' | 'unresolved';

/**
 * Where the yes arrived: the inbound row's group bit, or SMS, which has no group. A null
 * bit on iMessage (a row stored before the bit existed) is `unresolved` and read as the
 * group; the router already refuses such turns (`group_unscoped`), so this only fails
 * closed if one ever gets through.
 */
async function yesThread(database: Database, input: SignupRunInput): Promise<YesThread> {
  const id = input.inboundChannelMessageId;
  if (!id || !isUuid(id)) return 'unresolved';
  const [row] = await database
    .select({ inGroup: schema.channelMessages.inGroup, channel: schema.channelMessages.channel })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.id, id),
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    )
    .limit(1);
  if (!row) return 'unresolved';
  if (row.inGroup !== null) return row.inGroup ? 'group' : 'private';
  return row.channel === 'sms' ? 'private' : 'unresolved';
}

/** Outcomes where the parent fills the provider's form next, so the pack helps. */
function parentFillsForm(handoff: BrowserUseHandoff): boolean {
  if (handoff.outcome === 'needs_human') return handoff.detail !== 'unconfirmed';
  return (
    handoff.outcome === 'needs_login' || handoff.outcome === 'rush' || handoff.outcome === 'error'
  );
}

/** The live view only after a 1:1 yes; nothing after a confirmed booking; else the public page. */
function handoffLink(
  handoff: BrowserUseHandoff,
  registrationUrl: string,
  privately: boolean,
  confirmed: boolean,
): { link: string; linkIs: SignupOutcomeFacts['linkIs'] } {
  if (privately && handoff.liveViewUrl !== null) {
    return { link: handoff.liveViewUrl, linkIs: 'live_browser' };
  }
  if (confirmed) return { link: '', linkIs: null };
  return { link: registrationUrl, linkIs: 'registration_page' };
}

function browserUseReplyFacts(
  handoff: BrowserUseHandoff,
  ctx: {
    offerId: string;
    href: string;
    host: string | null;
    identity: SignupIdentity;
    session: { label: string };
  },
  privately: boolean,
  rush: RushHandoff | null,
): ReplyFacts {
  const confirmed = handoff.outcome === 'completed' && handoff.confirmationNumber !== null;
  const { link, linkIs } = handoffLink(handoff, ctx.href, privately, confirmed);
  const holdMinutes =
    linkIs === 'live_browser' && handoff.holdExpiresAt
      ? Math.max(0, Math.floor((handoff.holdExpiresAt.getTime() - Date.now()) / 60_000))
      : null;
  const pack =
    privately && linkIs === 'registration_page' && parentFillsForm(handoff)
      ? signupInfoPack(ctx.identity)
      : [];
  return {
    offerId: ctx.offerId,
    outcome: handoff.outcome,
    reason: handoff.detail === 'none' ? null : handoff.detail,
    link,
    linkIs,
    holdMinutes,
    ...(pack.length > 0 ? { pack } : {}),
    inGroup: !privately,
    prefilled: [],
    host: ctx.host,
    sessionLabel: ctx.session.label,
    rush,
    ...(confirmed ? { confirmation: { kind: 'confirmation_number' as const } } : {}),
  };
}

async function replyFor(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  door: ReportDoor,
  rawFacts: ReplyFacts,
): Promise<SignupRunResult> {
  const checked = confirmedOutcome(rawFacts);
  const facts: ReplyFacts = {
    ...rawFacts,
    outcome: checked.outcome,
    reason:
      checked.outcome === 'unconfirmed' && rawFacts.reason === null
        ? 'unconfirmed'
        : rawFacts.reason,
  };
  const writer = deps.outcomeWriter ?? defaultOutcomeWriter();
  // A held turn sends nothing, so the pack and the live view never go to the model.
  const line: string | null =
    door.kind === 'held'
      ? null
      : await writer.write({
          outcome: facts.outcome,
          reason: facts.reason,
          confirmed: checked.confirmed,
          sessionLabel: facts.sessionLabel ? collapseSignupFact(facts.sessionLabel) : null,
          link: facts.link,
          linkIs: facts.linkIs ?? (facts.link ? 'registration_page' : null),
          holdMinutes: facts.holdMinutes ?? null,
          audience: door.kind === 'group' || facts.inGroup === true ? 'group' : 'direct',
          prefilled: facts.prefilled,
          ...(facts.pack
            ? {
                pack: facts.pack.map((item) => ({
                  slot: item.slot,
                  value: collapseSignupFact(item.value),
                })),
              }
            : {}),
          rush: facts.rush
            ? {
                signal: facts.rush.signal,
                opensAt: facts.rush.opensAt,
                prefillSlots: facts.rush.prefill.map((item) => item.slot),
              }
            : null,
          question: facts.question ?? null,
          language: await readParentLanguage(database, {
            familyId: input.familyId,
            parentUserId: input.parentUserId,
          }),
        });
  await writeAudit(database, input, facts.offerId, {
    step: 'report',
    outcome: facts.outcome,
    reason: facts.reason,
    replied: line !== null,
    door: door.kind,
    host: facts.host,
    fieldsFilled: facts.prefilled,
    ...(facts.runtimeSkipped ? { runtimeSkipped: facts.runtimeSkipped } : {}),
    ...(facts.rush ? { rushSignal: facts.rush.signal, rushOpensAt: facts.rush.opensAt } : {}),
  });
  const rush = facts.rush ? { rush: facts.rush } : {};
  if (door.kind === 'held') {
    return { ...rush, claimed: true, outcome: facts.outcome, reply: null, deliverOnThread: false };
  }
  if (line === null) {
    // No reply model or no acceptable draft: nothing is sent, and there is no fixed fallback.
    console.warn({ outcome: facts.outcome }, 'authorized signup: outcome reply unwritten');
    return {
      ...rush,
      claimed: true,
      outcome: facts.outcome,
      reply: null,
      deliverOnThread: false,
      unsent: 'reply_unwritten',
    };
  }
  if (door.kind === 'group') {
    const send =
      deps.deliverGroup ?? ((item: GroupSignupDelivery) => sendSignupToGroup(database, item));
    const status = await send({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      chatId: door.chatId,
      body: line,
      dedupeKey: `authorized_signup:${facts.offerId}:${facts.outcome}`,
      now: input.now,
      stamp: askStamp(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        offerIds: [facts.offerId],
      }),
    });
    if (status === 'sent' || status === 'already_sent') {
      return {
        ...rush,
        claimed: true,
        outcome: facts.outcome,
        reply: null,
        deliverOnThread: false,
      };
    }
    console.warn(
      { familyId: input.familyId, offerId: facts.offerId, outcome: facts.outcome },
      'authorized signup: group door failed, replying on the thread the parent opened',
    );
    if (!input.existingThread) {
      return {
        ...rush,
        claimed: true,
        outcome: facts.outcome,
        reply: null,
        deliverOnThread: false,
      };
    }
  }
  return {
    ...rush,
    claimed: true,
    outcome: facts.outcome,
    reply: line,
    deliverOnThread: true,
    stamp: askStamp(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      offerIds: [facts.offerId],
    }),
  };
}

async function writeAudit(
  database: Database,
  input: SignupRunInput,
  offerId: string | null,
  after: Record<string, unknown>,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: 'authorized_signup_step',
    targetTable: 'authorized_signup_offers',
    targetId: offerId,
    after: redactSignupAudit(after),
  });
}
