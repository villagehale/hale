import type { ShareableSignupField } from '../consent';
import { LINK_SPEND_CEILING_CENTS, LinkApiError, type LinkCard } from '../link/client';
import type { SignupPaymentWallet } from '../link/wallet';
import type { SignupIdentity } from '../types';
import {
  type BrowserUseApi,
  BrowserUseApiError,
  type BrowserUseRunStatus,
  TERMINAL_RUN_STATUSES,
} from './client';
import {
  BROWSER_USE_CONFIRMATION_OUTPUT_SCHEMA,
  BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
  BROWSER_USE_SIGNUP_OUTPUT_SCHEMA,
  type BrowserUseSignupDetail,
  type BrowserUseSignupOutcome,
  cardAllowedDomains,
  parseConfirmationOutput,
  parsePaymentOutput,
  parseSignupOutput,
  sameProviderHttpsUrl,
} from './outcome';
import type { ProviderSessionSeeder } from './seed';
import type { ProviderStorageState } from './vault';

/**
 * T8 — drives a provider's real registration site with Browser Use Cloud
 * through the parent's saved sign-in. One generic agent task for every
 * provider, no per-site script. With a Stripe Link wallet the agent pays the
 * exact cart total after the parent approves in Link; without one, or when
 * approval times out, it stops at checkout and the parent pays on the live
 * browser this returns. A queue or timed open comes back as `rush`.
 *
 * Never sent: a password, a card number, `secretBindings` or a 1Password
 * vault. The Link connection id is the only payment input; Link issues the
 * one-time card. AgentMail is off. The browser keeps the cart alive for
 * `CHECKOUT_KEEP_ALIVE_SECONDS` after the run stops, which is the parent's
 * window to pay; provider cart holds are usually shorter, so the hold the page
 * states wins when it is shorter.
 */
export const CHECKOUT_KEEP_ALIVE_SECONDS = 900;
export const DEFAULT_CART_HOLD_MINUTES = 10;
export const RUN_DEADLINE_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_MS = 2000;
export const SIGNUP_RUN_MAX_COST_USD = 3;
export const CONFIRMATION_RUN_MAX_COST_USD = 0.5;
const SEED_BROWSER_TIMEOUT_MINUTES = 5;

export const SIGNUP_SKILL = 'browser-use-signup';
export const PAYMENT_SKILL = 'browser-use-payment';
export const PAYMENT_RUN_MAX_COST_USD = 1;
export const LINK_POLL_INTERVAL_MS = 3000;
export const CONFIRMATION_SKILL = 'browser-use-confirmation';

export type BrowserUseEngineDetail =
  | BrowserUseSignupDetail
  | 'seed_unavailable'
  | 'seed_failed'
  | 'browser_unavailable'
  | 'run_failed'
  | 'run_cancelled'
  | 'timeout'
  | 'unreadable_output'
  | 'no_live_view'
  | 'payment_boundary'
  | 'charge_mismatch'
  | 'charge_unverified'
  /** Paid the right amount but no confirmation was captured: never reported as signed up. */
  | 'unconfirmed'
  | 'amount_changed'
  | 'payment_ceiling'
  | 'currency_unknown'
  | 'approval_timeout'
  | 'payment_denied'
  | 'payment_failed'
  | 'card_unavailable'
  | 'card_declined'
  | 'link_api_error'
  | 'api_error';

export interface BrowserUseSignupInput {
  /** Opaque id that labels the Browser Use profile. Never a name. */
  correlationId: string;
  registrationUrl: string;
  identity: SignupIdentity;
  /** The consent grant. A detail outside it never reaches the task. */
  fieldsAllowed: readonly ShareableSignupField[];
  session: {
    label: string;
    startsAt: string;
    endsAt: string;
    partySize?: number | null;
    seatingNote?: string | null;
  };
  approvedPriceCents: number | null;
  /** The parent's own Link wallet. Null keeps the run at checkout: the parent pays. */
  payment: SignupPaymentWallet | null;
  providerSession: { storageState: ProviderStorageState; browserUseProfileId: string | null };
  /** Persists a newly created profile id so the 48h sweep can delete it. */
  onProfileCreated: (profileId: string) => Promise<void>;
}

/** The agent's outcomes plus the two that only the payment step reaches. */
export type BrowserUseEngineOutcome =
  | BrowserUseSignupOutcome
  | 'completed'
  | 'payment_not_approved';

export interface BrowserUseSignupResult {
  outcome: BrowserUseEngineOutcome;
  detail: BrowserUseEngineDetail;
  /** Credential-grade. Hand to the parent only; never log or audit it. */
  liveViewUrl: string | null;
  checkoutUrl: string | null;
  holdExpiresAt: Date | null;
  cartTotalCents: number | null;
  /** Set when the agent paid; otherwise read later with `readBrowserUseConfirmation`. */
  confirmationNumber: string | null;
  /** The open time a rush page states, as written. */
  opensAt: string | null;
  /** What the provider charged the one-time Link card. Equals the cart total. */
  amountChargedCents: number | null;
  runId: string | null;
  /** Browser Use session id, for the confirmation follow-up. */
  sessionId: string | null;
  costUsd: string | null;
}

export type BrowserUseConfirmationResult =
  | { outcome: 'confirmed'; confirmationNumber: string | null; costUsd: string | null }
  | { outcome: 'not_confirmed'; costUsd: string | null }
  | { outcome: 'error'; detail: BrowserUseEngineDetail };

export interface BrowserUseEngineDeps {
  api: BrowserUseApi;
  /** Null names a missing CDP client; a fresh profile cannot be seeded then. */
  seeder: ProviderSessionSeeder | null;
  /** Returns the versioned skill body by name. */
  loadTask: (skill: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function failure(
  outcome: BrowserUseEngineOutcome,
  detail: BrowserUseEngineDetail,
  run: { runId?: string | null; sessionId?: string | null; costUsd?: string | null } = {},
): BrowserUseSignupResult {
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
    runId: run.runId ?? null,
    sessionId: run.sessionId ?? null,
    costUsd: run.costUsd ?? null,
  };
}

/** Only the slots on the consent grant, and only those with a value. */
export function signupFacts(input: BrowserUseSignupInput): Record<string, unknown> {
  const grant = new Set<string>(input.fieldsAllowed);
  const pick = (slot: ShareableSignupField, value: string | number | null | undefined) => {
    if (!grant.has(slot) || value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim().length === 0) return undefined;
    return typeof value === 'string' ? value.trim() : value;
  };
  const { identity, session } = input;
  return {
    registration_url: input.registrationUrl,
    approved_price_cents: input.approvedPriceCents,
    session: {
      label: pick('session', session.label),
      starts_at: session.startsAt,
      ends_at: session.endsAt,
      party_size: pick('party_size', session.partySize),
      seating_note: pick('seating_note', session.seatingNote),
    },
    child: {
      first_name: pick('child_first_name', identity.childFirstName),
      last_name: pick('child_last_name', identity.childLastName),
      date_of_birth: pick('child_dob', identity.childDob),
    },
    parent: {
      first_name: pick('parent_first_name', identity.parentFirstName),
      email: pick('parent_email', identity.parentEmail),
      postal_code: pick('postal_code', identity.postalCode),
    },
  };
}

function taskWithFacts(skillBody: string, facts: Record<string, unknown>): string {
  return `${skillBody.trim()}\n\n## This registration\n\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n`;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

type RunWait =
  | { kind: 'terminal'; status: BrowserUseRunStatus; liveViewUrl: string | null }
  | { kind: 'timeout'; liveViewUrl: string | null };

async function waitForRun(deps: BrowserUseEngineDeps, runId: string): Promise<RunWait> {
  const deadline = deps.now().getTime() + RUN_DEADLINE_MS;
  let cursor = 0;
  let liveViewUrl: string | null = null;
  for (;;) {
    const status = await deps.api.getRunStatus(runId);
    for (let page = 0; page < 20; page += 1) {
      const events = await deps.api.getRunEvents(runId, cursor);
      for (const event of events.events) {
        cursor = Math.max(cursor, event.id);
        if (event.type === 'browser.ready' || event.type === 'browser.reattached') {
          liveViewUrl = httpsUrl(event.data.live_view_url) ?? liveViewUrl;
        }
      }
      if (events.nextAfter === null || events.nextAfter <= cursor) {
        if (events.nextAfter !== null) cursor = Math.max(cursor, events.nextAfter);
        break;
      }
      cursor = events.nextAfter;
    }
    if (TERMINAL_RUN_STATUSES.includes(status)) return { kind: 'terminal', status, liveViewUrl };
    if (deps.now().getTime() >= deadline) {
      await deps.api.cancelRun(runId).catch(() => undefined);
      return { kind: 'timeout', liveViewUrl };
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

async function ensureProfile(
  input: BrowserUseSignupInput,
  deps: BrowserUseEngineDeps,
): Promise<{ ok: true; profileId: string } | { ok: false; detail: BrowserUseEngineDetail }> {
  const existing = input.providerSession.browserUseProfileId;
  if (existing) return { ok: true, profileId: existing };
  if (!deps.seeder) return { ok: false, detail: 'seed_unavailable' };
  const profile = await deps.api.createProfile({
    name: 'hale-signup',
    userId: input.correlationId,
  });
  await input.onProfileCreated(profile.id);
  const browser = await deps.api.createBrowser({
    profileId: profile.id,
    timeoutMinutes: SEED_BROWSER_TIMEOUT_MINUTES,
  });
  try {
    if (!browser.cdpUrl) return { ok: false, detail: 'browser_unavailable' };
    try {
      await deps.seeder.seed(browser.cdpUrl, input.providerSession.storageState);
    } catch {
      return { ok: false, detail: 'seed_failed' };
    }
  } finally {
    // Stopping saves the seeded cookies into the profile.
    await deps.api.stopBrowser(browser.id);
  }
  return { ok: true, profileId: profile.id };
}

export async function runBrowserUseSignup(
  input: BrowserUseSignupInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUseSignupResult> {
  let runId: string | null = null;
  let sessionId: string | null = null;
  try {
    const profile = await ensureProfile(input, deps);
    if (!profile.ok) return failure('error', profile.detail);

    const task = taskWithFacts(await deps.loadTask(SIGNUP_SKILL), signupFacts(input));
    const run = await deps.api.createRun({
      task,
      outputSchema: BROWSER_USE_SIGNUP_OUTPUT_SCHEMA,
      browserSettings: { profileId: profile.profileId, record: false },
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
      maxCostUsd: SIGNUP_RUN_MAX_COST_USD,
    });
    runId = run.id;
    sessionId = run.sessionId;

    const waited = await waitForRun(deps, run.id);
    if (waited.kind === 'timeout') return failure('error', 'timeout', { runId, sessionId });
    const summary = await deps.api.getRun(run.id);
    const ids = { runId, sessionId: summary.sessionId || sessionId, costUsd: summary.totalCostUsd };
    if (waited.status === 'failed') return failure('error', 'run_failed', ids);
    if (waited.status === 'cancelled') return failure('error', 'run_cancelled', ids);

    const output = parseSignupOutput(summary.output);
    if (!output) return failure('error', 'unreadable_output', ids);
    if (output.payment_details_entered) return failure('error', 'payment_boundary', ids);

    const live = waited.liveViewUrl;
    if (output.outcome === 'rush') {
      return { ...failure('rush', output.detail, ids), opensAt: output.opens_at };
    }
    if (output.outcome === 'reached_checkout') {
      const total = output.cart_total_cents;
      if (input.approvedPriceCents !== null && total !== null && total > input.approvedPriceCents) {
        return {
          ...failure('needs_human', 'price_change', ids),
          liveViewUrl: live,
          cartTotalCents: total,
        };
      }
      if (!live) return failure('error', 'no_live_view', ids);
      const holdMinutes = Math.min(
        output.hold_minutes ?? DEFAULT_CART_HOLD_MINUTES,
        CHECKOUT_KEEP_ALIVE_SECONDS / 60,
      );
      const checkout: BrowserUseSignupResult = {
        ...failure(output.outcome, output.detail, ids),
        liveViewUrl: live,
        checkoutUrl: sameProviderHttpsUrl(output.checkout_url, input.registrationUrl),
        holdExpiresAt: new Date(deps.now().getTime() + holdMinutes * 60_000),
        cartTotalCents: total,
      };
      if (!input.payment) return checkout;
      return await payAtCheckout(input, deps, input.payment, checkout, {
        total,
        currency: output.cart_currency,
        paymentHosts: output.payment_hosts,
      });
    }
    const handsOn = output.outcome === 'needs_human' || output.outcome === 'needs_login';
    return {
      ...failure(output.outcome, output.detail, ids),
      liveViewUrl: handsOn ? live : null,
      cartTotalCents: output.cart_total_cents,
    };
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError)
      return failure('error', 'api_error', { runId, sessionId });
    throw error;
  }
}

function sumCost(a: string | null, b: string | null): string | null {
  if (a === null && b === null) return null;
  return (Number(a ?? 0) + Number(b ?? 0)).toFixed(4);
}

/** Shown to the parent in Link. Facts only: no child name, no card data. */
function spendContext(input: BrowserUseSignupInput, totalCents: number, currency: string): string {
  const host = new URL(input.registrationUrl).hostname;
  const amount = (totalCents / 100).toFixed(2);
  return `Registration for "${input.session.label}" starting ${input.session.startsAt} on ${host}, which you asked Hale to book. One-time card for the exact cart total of ${amount} ${currency.toUpperCase()}.`;
}

/**
 * The cart is held at checkout. The parent's own Link wallet issues a one-time
 * card for exactly the cart total once they approve with Face ID or a passkey;
 * no approval in the window hands the live checkout back to the parent.
 */
async function payAtCheckout(
  input: BrowserUseSignupInput,
  deps: BrowserUseEngineDeps,
  wallet: SignupPaymentWallet,
  checkout: BrowserUseSignupResult,
  cart: { total: number | null; currency: string | null; paymentHosts: readonly string[] },
): Promise<BrowserUseSignupResult> {
  const total = cart.total;
  if (
    total === null ||
    total <= 0 ||
    input.approvedPriceCents === null ||
    total > input.approvedPriceCents ||
    total > LINK_SPEND_CEILING_CENTS
  ) {
    return { ...checkout, detail: 'payment_ceiling' };
  }
  if (!cart.currency) return { ...checkout, detail: 'currency_unknown' };
  if (!checkout.sessionId) return checkout;
  const notApproved = (detail: BrowserUseEngineDetail): BrowserUseSignupResult => ({
    ...checkout,
    outcome: 'payment_not_approved',
    detail,
  });
  let requestId: string | null = null;
  const cancel = async () => {
    if (requestId) await wallet.api.cancelSpendRequest(requestId).catch(() => undefined);
  };
  try {
    const created = await wallet.api.createSpendRequest({
      amountCents: total,
      currency: cart.currency,
      merchantName: new URL(input.registrationUrl).hostname,
      merchantUrl: checkout.checkoutUrl ?? input.registrationUrl,
      context: spendContext(input, total, cart.currency),
      idempotencyKey: `hale-signup-${input.correlationId}-${total}`,
    });
    requestId = created.id;
    if (created.amount !== total) {
      await cancel();
      return notApproved('payment_failed');
    }
    const deadline = deps.now().getTime() + wallet.approvalWindowMinutes * 60_000;
    let status = created.status;
    while (status === 'pending_approval' || status === 'created') {
      if (deps.now().getTime() >= deadline) {
        await cancel();
        return notApproved('approval_timeout');
      }
      await deps.sleep(LINK_POLL_INTERVAL_MS);
      status = (await wallet.api.retrieveSpendRequest(created.id)).status;
    }
    if (status === 'denied') return notApproved('payment_denied');
    if (status !== 'approved') {
      await cancel();
      return notApproved('payment_failed');
    }
    const card = await wallet.api.retrieveCard(created.id);
    if (!card) {
      await cancel();
      return notApproved('card_unavailable');
    }
    return await placeOrder(input, deps, checkout, {
      total,
      currency: cart.currency,
      card,
      allowedDomains: cardAllowedDomains(input.registrationUrl, cart.paymentHosts),
      sessionId: checkout.sessionId,
      cancel,
    });
  } catch (error) {
    if (error instanceof LinkApiError) {
      await cancel();
      return notApproved('link_api_error');
    }
    throw error;
  }
}

function paymentTask(skillBody: string, facts: Record<string, unknown>): string {
  return `${skillBody.trim()}\n\n## This payment\n\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n`;
}

/**
 * A follow-up run in the same browser types the card by secret alias, only on
 * the provider's host and its payment frames, and places the order once.
 */
async function placeOrder(
  input: BrowserUseSignupInput,
  deps: BrowserUseEngineDeps,
  checkout: BrowserUseSignupResult,
  pay: {
    total: number;
    currency: string;
    card: LinkCard;
    allowedDomains: string[];
    sessionId: string;
    cancel: () => Promise<void>;
  },
): Promise<BrowserUseSignupResult> {
  const month = String(pay.card.expMonth).padStart(2, '0');
  const year = String(pay.card.expYear);
  const bind = (alias: string, value: string) => ({
    alias,
    source: { type: 'inline' as const, value },
    allowedDomains: pay.allowedDomains,
  });
  const secretBindings = [
    bind('card_number', pay.card.number),
    bind('card_expiry', `${month}/${year.slice(-2)}`),
    bind('card_exp_month', month),
    bind('card_exp_year', year),
    ...(pay.card.cvc ? [bind('card_cvc', pay.card.cvc)] : []),
    ...(pay.card.postalCode ? [bind('card_postal_code', pay.card.postalCode)] : []),
  ];
  let runId: string | null = null;
  const handsOn = (
    detail: BrowserUseEngineDetail,
    extra: Partial<BrowserUseSignupResult> = {},
  ): BrowserUseSignupResult => ({
    ...checkout,
    outcome: 'needs_human',
    detail,
    runId: runId ?? checkout.runId,
    ...extra,
  });
  try {
    const run = await deps.api.createRun({
      task: paymentTask(await deps.loadTask(PAYMENT_SKILL), {
        amount_cents: pay.total,
        currency: pay.currency,
        registration_url: input.registrationUrl,
      }),
      outputSchema: BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
      sessionId: pay.sessionId,
      secretBindings,
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
      maxCostUsd: PAYMENT_RUN_MAX_COST_USD,
    });
    runId = run.id;
    const waited = await waitForRun(deps, run.id);
    const liveViewUrl = waited.liveViewUrl ?? checkout.liveViewUrl;
    if (waited.kind === 'timeout') {
      await deps.api.cancelRun(run.id).catch(() => undefined);
      return handsOn('timeout', { liveViewUrl });
    }
    const summary = await deps.api.getRun(run.id);
    const costUsd = sumCost(checkout.costUsd, summary.totalCostUsd);
    if (waited.status !== 'completed') return handsOn('run_failed', { liveViewUrl, costUsd });
    const output = parsePaymentOutput(summary.output);
    if (!output) return handsOn('unreadable_output', { liveViewUrl, costUsd });
    if (output.outcome === 'paid') {
      const charged = output.amount_charged_cents;
      if (charged !== pay.total) {
        return handsOn(charged === null ? 'charge_unverified' : 'charge_mismatch', {
          liveViewUrl,
          costUsd,
          amountChargedCents: charged,
          confirmationNumber: output.confirmation_number,
        });
      }
      if (!output.confirmation_number) {
        return handsOn('unconfirmed', { liveViewUrl, costUsd, amountChargedCents: charged });
      }
      return {
        ...checkout,
        outcome: 'completed',
        detail: 'none',
        liveViewUrl: null,
        checkoutUrl: null,
        holdExpiresAt: null,
        confirmationNumber: output.confirmation_number,
        amountChargedCents: charged,
        runId: run.id,
        costUsd,
      };
    }
    await pay.cancel();
    if (output.outcome === 'declined') {
      return {
        ...checkout,
        outcome: 'payment_not_approved',
        detail: 'card_declined',
        liveViewUrl,
        runId: run.id,
        costUsd,
      };
    }
    return handsOn(output.detail === 'none' ? 'page_error' : output.detail, {
      liveViewUrl,
      costUsd,
    });
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) {
      await pay.cancel();
      return handsOn('api_error');
    }
    throw error;
  }
}

/**
 * After the parent paid on the live browser: a read-only follow-up in the same
 * Browser Use session reads the confirmation page. The caller deletes the
 * provider session once this says confirmed.
 */
export async function readBrowserUseConfirmation(
  input: { sessionId: string },
  deps: BrowserUseEngineDeps,
): Promise<BrowserUseConfirmationResult> {
  try {
    const run = await deps.api.createRun({
      task: (await deps.loadTask(CONFIRMATION_SKILL)).trim(),
      outputSchema: BROWSER_USE_CONFIRMATION_OUTPUT_SCHEMA,
      sessionId: input.sessionId,
      agentmail: false,
      maxCostUsd: CONFIRMATION_RUN_MAX_COST_USD,
    });
    const waited = await waitForRun(deps, run.id);
    if (waited.kind === 'timeout') return { outcome: 'error', detail: 'timeout' };
    const summary = await deps.api.getRun(run.id);
    if (waited.status === 'failed') return { outcome: 'error', detail: 'run_failed' };
    if (waited.status === 'cancelled') return { outcome: 'error', detail: 'run_cancelled' };
    const output = parseConfirmationOutput(summary.output);
    if (!output) return { outcome: 'error', detail: 'unreadable_output' };
    if (!output.on_confirmation_page) {
      return { outcome: 'not_confirmed', costUsd: summary.totalCostUsd };
    }
    return {
      outcome: 'confirmed',
      confirmationNumber: output.confirmation_number,
      costUsd: summary.totalCostUsd,
    };
  } catch (error) {
    if (error instanceof BrowserUseApiError) return { outcome: 'error', detail: 'api_error' };
    throw error;
  }
}
