import { type Database, schema } from '@hale/db';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { redactSignupAudit } from './audit';
import { authorizeSignup } from './authorize';
import {
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
import { type SignupOutcomeWriter, createSignupOutcomeWriter } from './outcome-reply';
import { type InfoPackSlot, signupInfoPack } from './pack';
import { type BookingConnector, bookingRoute } from './providers';
import { type GroupSignupDelivery, sendSignupToGroup } from './report';
import type { SignupRuntimeAcquire, SignupRuntimeSkipped } from './runtime/types';
import {
  browserUseRegistrationSpendUsd,
  loadBusy,
  loadPendingOffer,
  loadSignupIdentity,
  markOffer,
  recordBrowserUseCost,
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
}

export interface SignupRunDeps {
  /** Reads whether the parent said to sign up. Undefined uses the reply model. */
  consentReader?: SignupConsentReader;
  /** Writes the parent's reply from the structured outcome. Undefined uses the reply model. */
  outcomeWriter?: SignupOutcomeWriter;
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
  deliverOnThread: boolean;
  /**
   * Set on the Browser Use path. Hale's AI writes the parent message from it;
   * this module has no fixed copy for it. `liveViewUrl` goes to the parent only.
   */
  browserUse?: BrowserUseHandoff;
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
      runId: null;
      sessionId: null;
      costUsd: null;
      sessionCostUsd: null;
      browserId: null;
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

  // No pending offer: nothing to consent to, and the message is someone else's.
  const offer = await loadPendingOffer(database, input.familyId);
  if (!offer) return UNCLAIMED;
  const reader = deps.consentReader ?? defaultConsentReader();
  const reading: SignupConsentReading | null = await reader.read({ text: input.body, offer });
  // Unreadable (no model, model failure) is not consent and does not claim the message.
  if (!reading || reading.verdict === 'unrelated') return UNCLAIMED;
  if (reading.verdict === 'consent' && deps.declineSeat && (await deps.declineSeat())) {
    return {
      claimed: true,
      outcome: 'group_member_not_authorized',
      reply: null,
      deliverOnThread: false,
    };
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

  if (reading.verdict === 'unclear') {
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'clarify',
      reason: null,
      link: '',
      prefilled: [],
      host,
      question: reading.question,
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
export const BROWSER_USE_WORST_CASE_RUN_USD = SIGNUP_RUN_MAX_COST_USD + PAYMENT_RUN_MAX_COST_USD;

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
 * page comes back as a handoff. No parent copy is written here.
 */
async function runBrowserUseBranch(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  ctx: {
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
    if (handoff.sessionCostUsd !== null) {
      await recordBrowserUseCost(database, {
        offerId: ctx.offerId,
        familyId: input.familyId,
        sessionCostUsd: handoff.sessionCostUsd,
        now: input.now,
      });
    }
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
    return {
      claimed: true,
      outcome: handoff.outcome,
      reply: null,
      deliverOnThread: false,
      browserUse: handoff,
      ...(rush ? { rush } : {}),
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
  // Production reserve for Browser Use registrations. A run can cost up to the
  // signup cap plus the payment cap, so a run starts only if that worst case
  // still fits under the reserve: total spend never passes it.
  const spentUsd = await browserUseRegistrationSpendUsd(database);
  if (spentUsd + BROWSER_USE_WORST_CASE_RUN_USD > BROWSER_USE_REGISTRATION_RESERVE_USD) {
    console.warn(
      { familyId: input.familyId, offerId: ctx.offerId, spentUsd },
      'authorized signup: browser use registration reserve reached',
    );
    return done(browserUseAbsent('error', 'spend_reserve_reached'));
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
}

function labelFor(offer: { sessions: { id: string; label: string }[] }, sessionId: string): string {
  return offer.sessions.find((item) => item.id === sessionId)?.label ?? '';
}

interface ReplyFacts {
  offerId: string | null;
  outcome: string;
  reason: SignupStopReason | null;
  link: string;
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

/** What proves a booking: the provider's confirmation page, or its booking API saying booked. */
export type SignupConfirmation = { kind: 'page' } | { kind: 'connector'; connector: string };

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
  const line: string | null = await writer.write({
    outcome: facts.outcome,
    reason: facts.reason,
    confirmed: checked.confirmed,
    sessionLabel: facts.sessionLabel ? collapseSignupFact(facts.sessionLabel) : null,
    link: facts.link,
    prefilled: facts.prefilled,
    rush: facts.rush
      ? {
          signal: facts.rush.signal,
          opensAt: facts.rush.opensAt,
          prefillSlots: facts.rush.prefill.map((item) => item.slot),
        }
      : null,
    question: facts.question ?? null,
    language: null,
  });
  await writeAudit(database, input, facts.offerId, {
    step: 'report',
    outcome: facts.outcome,
    reason: facts.reason,
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
    return { ...rush, claimed: true, outcome: facts.outcome, reply: null, deliverOnThread: false };
  }
  if (door.kind === 'group') {
    const send =
      deps.deliverGroup ?? ((item: GroupSignupDelivery) => sendSignupToGroup(database, item));
    const status = await send({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      chatId: door.chatId,
      body: line,
      dedupeKey: `authorized_signup:${facts.offerId ?? 'none'}:${facts.outcome}`,
      now: input.now,
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
  return { ...rush, claimed: true, outcome: facts.outcome, reply: line, deliverOnThread: true };
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
