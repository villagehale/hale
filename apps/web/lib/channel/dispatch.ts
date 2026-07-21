import { type LoopPrefsView, categoryEnabled, deliverableNow } from '~/lib/loop/prefs';
import { CATEGORY_CAPS } from './config';
import type { Channel, ChannelKind, LoopCategory, LoopMessage } from './types';

/**
 * F11 · The Sunday Loop — the dispatch (VIL-213 · A2). THE one place loop policy
 * is enforced: no caller reaches a provider except through here, so consent, the
 * A5 per-category enables, quiet hours, caps, dedupe, the channel_messages ledger,
 * audit rows, and the email CASL dual-write all happen exactly once.
 *
 * Order (ticket): category-enable → quiet hours → cap → dedupe → per-leg consent →
 * send → ledger. Delivery legs are the parent's exchange channel (loop_channel)
 * PLUS push when a live token exists (founder model: two exchange channels, three
 * delivery legs). Every outcome — a send OR a suppression — writes a ledger row.
 *
 * Pure orchestrator over injected ports so the policy is tested against Fakes with
 * no live provider (ticket's "business logic tested against Fakes" + hard rule #8
 * doesn't apply — this is deterministic, not an LLM).
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
  /** CASL express SMS consent, live (granted, not revoked, unexpired). */
  smsConsentLive(userId: string): Promise<boolean>;
  hasLivePushToken(userId: string): Promise<boolean>;
  /** Non-suppressed sends of this category to this parent since `since`. */
  countRecent(userId: string, category: LoopCategory, since: Date): Promise<number>;
  /** A prior send (not a suppression) already carries this dedupe key. */
  activeDedupe(dedupeKey: string): Promise<boolean>;
  /** Write one channel_messages row; returns its id (for the audit target). */
  record(write: LedgerWrite): Promise<string>;
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
  renderer: { render: (m: LoopMessage, c: ChannelKind, nameLevel: LoopPrefsView['childNameLevel']) => import('./types').RenderedContent };
}

export interface DispatchResult {
  outcome: 'suppressed' | 'dedupe_skipped' | 'delivered';
  suppression?: SuppressionStatus;
  sent: ChannelKind[];
  failed: ChannelKind[];
}

/** Thrown on a TRANSIENT channel error so the drain re-queues (pg-boss backoff).
 * No terminal ledger row is written — the dedupe key guards the eventual re-send. */
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
  const prefs = await ports.loadPrefs(msg.parentUserId);

  // ── Message-level policy (once) ──────────────────────────────────────────
  if (!categoryEnabled(prefs, msg.category)) {
    await suppress(ports, msg, prefs.loopChannel, 'suppressed_pref');
    return { outcome: 'suppressed', suppression: 'suppressed_pref', sent: [], failed: [] };
  }

  const parent = await ports.loadParent(msg.parentUserId);

  const timeSensitive = msg.urgency === 'time_sensitive';
  if (!deliverableNow(prefs, now, parent.timezone, timeSensitive)) {
    await suppress(ports, msg, prefs.loopChannel, 'suppressed_quiet_hours');
    return { outcome: 'suppressed', suppression: 'suppressed_quiet_hours', sent: [], failed: [] };
  }

  const cap = CATEGORY_CAPS[msg.category];
  const since = new Date(now.getTime() - cap.windowHours * 3_600_000);
  if ((await ports.countRecent(msg.parentUserId, msg.category, since)) >= cap.max) {
    await suppress(ports, msg, prefs.loopChannel, 'suppressed_cap');
    return { outcome: 'suppressed', suppression: 'suppressed_cap', sent: [], failed: [] };
  }

  if (msg.dedupeKey && (await ports.activeDedupe(msg.dedupeKey))) {
    return { outcome: 'dedupe_skipped', sent: [], failed: [] };
  }

  // ── Delivery legs: exchange channel + push when a live token exists ───────
  const legs: ChannelKind[] = [prefs.loopChannel];
  if (await ports.hasLivePushToken(msg.parentUserId)) {
    legs.push('push');
  }

  const sent: ChannelKind[] = [];
  const failed: ChannelKind[] = [];
  let dedupeConsumed = false;

  for (const channelKind of legs) {
    // Per-leg consent (email opt-out / SMS express consent; push needs neither).
    if (channelKind === 'email' && (await ports.emailOptedOut(msg.parentUserId, msg.category))) {
      await suppress(ports, msg, 'email', 'suppressed_consent');
      continue;
    }
    if (channelKind === 'sms' && !(await ports.smsConsentLive(msg.parentUserId))) {
      await suppress(ports, msg, 'sms', 'suppressed_consent');
      continue;
    }

    const rendered = ports.renderer.render(msg, channelKind, prefs.childNameLevel);
    const channel = ports.channels[channelKind];
    if (!channel) {
      await ports.record(row(msg, channelKind, 'failed', { errorCode: 'channel_unavailable' }));
      failed.push(channelKind);
      continue;
    }

    const result = await channel.send({ userId: msg.parentUserId, rendered });
    if (result.status === 'error' && result.transient) {
      // Retryable: let the drain re-queue. Dedupe guards the eventual re-send.
      throw new ChannelRetryableError(channelKind, result.code, result.message);
    }

    if (result.status === 'sent') {
      // The dedupe key rides the FIRST successful send (unique-where-not-null).
      const dedupeKey = !dedupeConsumed ? (msg.dedupeKey ?? null) : null;
      const id = await ports.record(
        row(msg, channelKind, 'sent', {
          dedupeKey,
          providerMessageId: result.providerMessageId,
          sentAt: now,
        }),
      );
      if (dedupeKey) dedupeConsumed = true;
      sent.push(channelKind);

      if (channelKind === 'email' && parent.email) {
        // CASL legal sub-ledger, written only on a real send (dual-write).
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
        after: { channel: channelKind, category: msg.category },
      });
    } else {
      // Permanent error OR a skip (not configured / disabled / no address).
      const errorCode = result.status === 'error' ? result.code : result.reason;
      await ports.record(row(msg, channelKind, 'failed', { errorCode }));
      failed.push(channelKind);
    }
  }

  return { outcome: 'delivered', sent, failed };
}

function row(
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

/** A suppression never carries the dedupe key — a legitimate re-attempt (e.g.
 * after quiet hours) must not be blocked; only a real send consumes the key. */
async function suppress(
  ports: DispatchPorts,
  msg: LoopMessage,
  channel: ChannelKind,
  status: SuppressionStatus,
): Promise<void> {
  await ports.record(row(msg, channel, status, { dedupeKey: null }));
}
