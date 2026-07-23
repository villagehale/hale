import type { AnalyticsEvent } from '~/lib/analytics/events';
import { type LoopPrefsView, categoryEnabled, deliverableNow } from '~/lib/loop/prefs';
import { CATEGORY_CAPS } from './config';
import type { Channel, ChannelKind, LoopCategory, LoopMessage } from './types';

/**
 * F11 · The Sunday Loop — the dispatch (VIL-213 · A2). THE one place loop policy
 * is enforced: no caller reaches a provider except through here, so consent, the
 * A5 per-category enables, quiet hours, caps, dedupe, the channel_messages ledger,
 * audit rows, and the email CASL dual-write all happen exactly once.
 *
 * Delivery model (founder, locked): two exchange channels, three delivery legs —
 * PUSH MIRRORS, it never substitutes. The exchange send always goes via the
 * parent's loop_channel (email today, sms when live); push is an ADDITIONAL
 * always-on leg when a live token exists. So a weekly plan lands as an email AND a
 * push, not one-or-the-other.
 *
 * Policy is evaluated PER LEG through this single point, and every leg writes its
 * own ledger row — a suppressed push leg alongside a delivered email leg is two
 * rows (one 'suppressed_*', one 'sent'). Dedupe + caps are per (parent, category,
 * CHANNEL) so a re-drain can't double-send EITHER leg, and the mirror's second leg
 * is never blocked by the first leg's cap.
 *
 * Pure orchestrator over injected ports so the policy is tested against Fakes with
 * no live provider.
 */

export type SuppressionStatus =
  | 'suppressed_pref'
  | 'suppressed_consent'
  | 'suppressed_quiet_hours'
  | 'suppressed_cap';

export interface LedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: ChannelKind;
  category: LoopCategory;
  templateKey: string;
  dedupeKey: string | null;
  status: 'sent' | 'failed' | SuppressionStatus;
  providerMessageId?: string | null;
  errorCode?: string | null;
  relatedActionId?: string | null;
  relatedConversationId?: string | null;
  sentAt?: Date | null;
}

/** The seam's dependencies, injected so the dispatch is a pure decision engine.
 * Prod wires these from the db (wiring.ts); tests pass Fakes. */
export interface DispatchPorts {
  now(): Date;
  loadPrefs(userId: string): Promise<LoopPrefsView>;
  loadParent(userId: string): Promise<{ email: string | null; timezone: string }>;
  /** CASL email opt-out for a loop stream (absence of opt-out = consent). */
  emailOptedOut(userId: string, emailType: string): Promise<boolean>;
  /** CASL express SMS consent, live (an active verified parent_channels row). */
  smsConsentLive(userId: string): Promise<boolean>;
  hasLivePushToken(userId: string): Promise<boolean>;
  /** Non-suppressed sends of this category on THIS channel to this parent since
   * `since` — the cap is per delivery leg (so a mirror leg isn't capped by the
   * other). */
  countRecent(
    userId: string,
    category: LoopCategory,
    channel: ChannelKind,
    since: Date,
  ): Promise<number>;
  /** A prior send (not a suppression) already carries this per-channel dedupe key. */
  activeDedupe(dedupeKey: string): Promise<boolean>;
  /** Write one channel_messages row; returns its id (for the audit target). */
  record(write: LedgerWrite): Promise<string>;
  /** X1 (VIL-227) loop taxonomy: fires the analytics event paired 1:1 with the
   * ledger row `record` just wrote — see `writeLedgerRow` below, the single point
   * both are called from. */
  capture(event: AnalyticsEvent, distinctId: string, properties?: Record<string, unknown>): Promise<void>;
  recordEmailSend(input: {
    userId: string;
    familyId: string;
    emailType: string;
    recipient: string;
    providerMessageId: string | null;
  }): Promise<void>;
  audit(row: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetTable: string;
    targetId: string;
    after: Record<string, unknown>;
  }): Promise<void>;
  channels: Partial<Record<ChannelKind, Channel>>;
  renderer: {
    render: (
      m: LoopMessage,
      c: ChannelKind,
      nameLevel: LoopPrefsView['childNameLevel'],
    ) => import('./types').RenderedContent;
  };
}

export type LegOutcome = 'sent' | 'failed' | 'deduped' | SuppressionStatus;

export interface LegResult {
  channel: ChannelKind;
  outcome: LegOutcome;
}

/** A per-leg accounting the caller / X1 can aggregate (no counter subsystem exists
 * in the repo, so the seam exports tallies through the return value). */
export interface DispatchResult {
  legs: LegResult[];
}

/** Thrown on a TRANSIENT channel error so the drain re-queues (pg-boss backoff).
 * No terminal ledger row is written — the per-channel dedupe key guards the
 * eventual re-send of just this leg. */
export class ChannelRetryableError extends Error {
  constructor(
    readonly channel: ChannelKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelRetryableError';
  }
}

export async function dispatchLoopMessage(
  msg: LoopMessage,
  ports: DispatchPorts,
): Promise<DispatchResult> {
  const now = ports.now();
  // Three independent per-parent reads — fetch in parallel (one round-trip instead of
  // three serial ones on the every-minute drain hot path).
  const [prefs, parent, hasLivePush] = await Promise.all([
    ports.loadPrefs(msg.parentUserId),
    ports.loadParent(msg.parentUserId),
    ports.hasLivePushToken(msg.parentUserId),
  ]);

  // Legs: the exchange channel + push when a live token exists (mirror, not fallback).
  const legs: ChannelKind[] = [prefs.loopChannel];
  if (hasLivePush) {
    legs.push('push');
  }

  const results: LegResult[] = [];
  for (const channel of legs) {
    results.push(await dispatchLeg(msg, channel, prefs, parent, now, ports));
  }
  return { legs: results };
}

async function dispatchLeg(
  msg: LoopMessage,
  channel: ChannelKind,
  prefs: LoopPrefsView,
  parent: { email: string | null; timezone: string },
  now: Date,
  ports: DispatchPorts,
): Promise<LegResult> {
  const suppressed = async (status: SuppressionStatus): Promise<LegResult> => {
    // A suppression never carries the dedupe key — a legitimate re-attempt (e.g.
    // after quiet hours) must not be blocked; only a real send consumes the key.
    await writeLedgerRow(ports, msg, channel, status, { dedupeKey: null });
    return { channel, outcome: status };
  };

  if (!categoryEnabled(prefs, msg.category)) {
    return suppressed('suppressed_pref');
  }

  const timeSensitive = msg.urgency === 'time_sensitive';
  if (!deliverableNow(prefs, now, parent.timezone, timeSensitive)) {
    return suppressed('suppressed_quiet_hours');
  }

  // Per-channel dedupe: this exact leg already sent / is in flight → no-op (a
  // re-drain can't double-send it), while the mirror leg stays independent.
  const legKey = msg.dedupeKey ? `${msg.dedupeKey}:${channel}` : null;
  if (legKey && (await ports.activeDedupe(legKey))) {
    return { channel, outcome: 'deduped' };
  }

  const cap = CATEGORY_CAPS[msg.category];
  const since = new Date(now.getTime() - cap.windowHours * 3_600_000);
  if ((await ports.countRecent(msg.parentUserId, msg.category, channel, since)) >= cap.max) {
    return suppressed('suppressed_cap');
  }

  if (channel === 'email' && (await ports.emailOptedOut(msg.parentUserId, msg.category))) {
    return suppressed('suppressed_consent');
  }
  if (channel === 'sms' && !(await ports.smsConsentLive(msg.parentUserId))) {
    return suppressed('suppressed_consent');
  }

  const rendered = ports.renderer.render(msg, channel, prefs.childNameLevel);
  const adapter = ports.channels[channel];
  if (!adapter) {
    await writeLedgerRow(ports, msg, channel, 'failed', { errorCode: 'channel_unavailable' });
    return { channel, outcome: 'failed' };
  }

  const result = await adapter.send({ userId: msg.parentUserId, rendered });
  if (result.status === 'error' && result.transient) {
    throw new ChannelRetryableError(channel, result.code, result.message);
  }

  if (result.status === 'sent') {
    const id = await writeLedgerRow(ports, msg, channel, 'sent', {
      dedupeKey: legKey,
      providerMessageId: result.providerMessageId,
      sentAt: now,
    });
    if (channel === 'email' && parent.email) {
      await ports.recordEmailSend({
        userId: msg.parentUserId,
        familyId: msg.familyId,
        emailType: msg.category,
        recipient: parent.email,
        providerMessageId: result.providerMessageId,
      });
    }
    await ports.audit({
      familyId: msg.familyId,
      actor: 'system',
      actionTaken: 'channel_sent',
      targetTable: 'channel_messages',
      targetId: id,
      after: { channel, category: msg.category },
    });
    return { channel, outcome: 'sent' };
  }

  // Permanent error OR a skip (not configured / disabled / no address).
  const errorCode = result.status === 'error' ? result.code : result.reason;
  await writeLedgerRow(ports, msg, channel, 'failed', { errorCode });
  return { channel, outcome: 'failed' };
}

/** The single point every terminal channel_messages write goes through: it writes
 * the ledger row AND fires the paired X1 taxonomy event, so "one ledger row ⇒
 * exactly one analytics event" holds by construction rather than by every call
 * site remembering both halves. `reason` carries the full ledger status (not just
 * a boolean) so the founder digest's suppression breakdown can distinguish WHY a
 * leg failed — safe to send (an enum, not user content). */
async function writeLedgerRow(
  ports: DispatchPorts,
  msg: LoopMessage,
  channel: ChannelKind,
  status: LedgerWrite['status'],
  extra: Partial<LedgerWrite> = {},
): Promise<string> {
  const id = await ports.record(rowFor(msg, channel, status, extra));
  const event: AnalyticsEvent = status === 'sent' ? 'loop_message_sent' : 'loop_message_failed';
  await ports.capture(event, msg.parentUserId, {
    channel,
    category: msg.category,
    templateKey: msg.templateKey,
    reason: status,
  });
  return id;
}

function rowFor(
  msg: LoopMessage,
  channel: ChannelKind,
  status: LedgerWrite['status'],
  extra: Partial<LedgerWrite> = {},
): LedgerWrite {
  return {
    familyId: msg.familyId,
    parentUserId: msg.parentUserId,
    channel,
    category: msg.category,
    templateKey: msg.templateKey,
    dedupeKey: extra.dedupeKey ?? null,
    status,
    relatedActionId: msg.relatedActionId ?? null,
    relatedConversationId: msg.relatedConversationId ?? null,
    ...extra,
  };
}
