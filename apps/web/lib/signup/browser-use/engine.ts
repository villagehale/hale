import type { ShareableSignupField } from '../consent';
import type { SignupIdentity } from '../types';
import {
  type BrowserUseApi,
  BrowserUseApiError,
  type BrowserUseRunStatus,
  TERMINAL_RUN_STATUSES,
} from './client';
import {
  BROWSER_USE_CONFIRMATION_OUTPUT_SCHEMA,
  BROWSER_USE_SIGNUP_OUTPUT_SCHEMA,
  type BrowserUseSignupDetail,
  type BrowserUseSignupOutcome,
  parseConfirmationOutput,
  parseSignupOutput,
  sameProviderHttpsUrl,
} from './outcome';
import type { ProviderSessionSeeder } from './seed';
import type { ProviderStorageState } from './vault';

/**
 * T8 — drives a provider's real registration site with Browser Use Cloud, up to
 * checkout, and stops. One generic agent task for every provider, no per-site
 * script. The parent pays on the live browser this returns.
 *
 * Never sent: a password, a card, `secretBindings`, a 1Password vault, or a
 * Stripe Link connection. AgentMail is off. The browser keeps the cart alive for
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
  providerSession: { storageState: ProviderStorageState; browserUseProfileId: string | null };
  /** Persists a newly created profile id so the 48h sweep can delete it. */
  onProfileCreated: (profileId: string) => Promise<void>;
}

export interface BrowserUseSignupResult {
  outcome: BrowserUseSignupOutcome;
  detail: BrowserUseEngineDetail;
  /** Credential-grade. Hand to the parent only; never log or audit it. */
  liveViewUrl: string | null;
  checkoutUrl: string | null;
  holdExpiresAt: Date | null;
  cartTotalCents: number | null;
  /** Always null here. Read later with `readBrowserUseConfirmation`. */
  confirmationNumber: null;
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
  outcome: BrowserUseSignupOutcome,
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
      return {
        ...failure('reached_checkout', output.detail, ids),
        liveViewUrl: live,
        checkoutUrl: sameProviderHttpsUrl(output.checkout_url, input.registrationUrl),
        holdExpiresAt: new Date(deps.now().getTime() + holdMinutes * 60_000),
        cartTotalCents: total,
      };
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
