import { type Database, schema } from '@hale/db';
import { familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { redactSignupAudit } from './audit';
import { authorizeSignup, isExplicitSignupUtterance } from './authorize';
import {
  ensureSignupConsent,
  fieldsPreparedToType,
  signupProviderHost,
  typedOutsideGrant,
} from './consent';
import { signupCompletedLine, signupHandbackLine } from './copy';
import { type ReportDoor, chooseReportDoor } from './door';
import { authorizedSignupEnabled } from './flag';
import { assistedHandoffLine, collapseSignupFact } from './handoff';
import { inspectRegistrationPage } from './inspect';
import { signupInfoPack } from './pack';
import { BOOKING_CONNECTORS, type BookingConnector, bookingRoute } from './providers';
import { type GroupSignupDelivery, sendSignupToGroup } from './report';
import type { SignupRuntimeAcquire, SignupRuntimeSkipped } from './runtime/types';
import { loadBusy, loadPendingOffer, loadSignupIdentity, markOffer } from './store';
import type { SignupBrowser, SignupPage, SignupStopReason } from './types';
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
  /** Undefined loads Playwright. Null means the browser is absent. */
  browser?: SignupBrowser | null;
  /** Defaults to none. A denylisted host never reaches a connector. */
  connectors?: readonly BookingConnector[];
  deliverGroup?: (input: GroupSignupDelivery) => Promise<'sent' | 'failed' | 'already_sent'>;
}

export interface SignupRunResult {
  claimed: boolean;
  outcome: string;
  reply: string | null;
  deliverOnThread: boolean;
}

const UNCLAIMED: SignupRunResult = {
  claimed: false,
  outcome: 'not_claimed',
  reply: null,
  deliverOnThread: false,
};

/**
 * Parent-authorized booking for anything a parent needs signed up. A connector
 * runs first when one is registered for the host. Otherwise the sandbox
 * browser opens that provider's own page and follows at most three steps.
 * A denylisted municipal host is an assisted handoff. A rush signal (queue,
 * captcha, resident or identity check, timed open-at) hands back with no
 * submit. The browser opens only after the gate accepts one activity, one
 * session, and the price, the result has a door, the child is not a teen, and
 * a consent row from this yes covers every slot about to be typed or packed.
 */
export async function runAuthorizedSignup(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps = {},
): Promise<SignupRunResult> {
  if (!authorizedSignupEnabled()) return { ...UNCLAIMED, outcome: 'flag_off' };
  if (!isExplicitSignupUtterance(input.body)) return UNCLAIMED;

  const offer = await loadPendingOffer(database, input.familyId);
  const door = await reportDoor(database, input);
  if (!offer) {
    return replyFor(database, input, deps, door, {
      offerId: null,
      outcome: 'no_offer',
      reason: 'no_offer',
      link: '',
      prefilled: [],
      host: null,
    });
  }

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

  const decision = authorizeSignup({
    utterance: input.body,
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
  if (identity.teenager) {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'teen_privacy',
      reason: 'teen_privacy',
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

  const route = bookingRoute(allowed.href, deps.connectors ?? BOOKING_CONNECTORS);
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
  const pack = route.kind === 'handoff' ? signupInfoPack(identity) : null;
  const typedFields = pack
    ? pack.map((slot) => slot.slot)
    : fieldsPreparedToType(identity, session);
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
  if (route.kind === 'handoff') {
    await markFromPending(database, input, offer.id, decision.sessionId);
    return replyFor(database, input, deps, door, {
      offerId: offer.id,
      outcome: 'assisted_handoff',
      reason: 'assisted_handoff',
      link: offer.registrationUrl,
      prefilled: pack?.map((slot) => slot.slot) ?? [],
      host,
      line: assistedHandoffLine({
        link: offer.registrationUrl,
        sessionLabel: session.label,
        pack: pack ?? [],
      }),
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

  if (route.kind === 'connector') {
    try {
      const booked = await route.connector.book({
        url: allowed.href,
        activityKey: decision.activityKey,
        sessionId: decision.sessionId,
        approvedPriceCents: offer.approvedPriceCents,
        identity,
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
    for (let step = 0; step < 3; step += 1) {
      const snapshot = await page.snapshot();
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
  /** Set for the assisted handoff, whose pack values must not be audited. */
  line?: string;
  /** Session label for the completed line. */
  sessionLabel?: string;
  /** Named reason the runtime handed back no browser. Absent when a browser ran. */
  runtimeSkipped?: SignupRuntimeSkipped | null;
}

async function replyFor(
  database: Database,
  input: SignupRunInput,
  deps: SignupRunDeps,
  door: ReportDoor,
  facts: ReplyFacts,
): Promise<SignupRunResult> {
  const line =
    facts.line ??
    (facts.outcome === 'completed'
      ? signupCompletedLine(collapseSignupFact(facts.sessionLabel ?? ''))
      : signupHandbackLine({
          reason: facts.reason ?? facts.outcome,
          link: facts.link,
          prefilled: facts.prefilled,
        }));
  await writeAudit(database, input, facts.offerId, {
    step: 'report',
    outcome: facts.outcome,
    reason: facts.reason,
    door: door.kind,
    host: facts.host,
    fieldsFilled: facts.prefilled,
    ...(facts.runtimeSkipped ? { runtimeSkipped: facts.runtimeSkipped } : {}),
  });
  if (door.kind === 'held') {
    return { claimed: true, outcome: facts.outcome, reply: null, deliverOnThread: false };
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
      return { claimed: true, outcome: facts.outcome, reply: null, deliverOnThread: false };
    }
    console.warn(
      { familyId: input.familyId, offerId: facts.offerId, outcome: facts.outcome },
      'authorized signup: group door failed, replying on the thread the parent opened',
    );
    if (!input.existingThread) {
      return { claimed: true, outcome: facts.outcome, reply: null, deliverOnThread: false };
    }
  }
  return { claimed: true, outcome: facts.outcome, reply: line, deliverOnThread: true };
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
