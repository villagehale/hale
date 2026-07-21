import type { ChildNameLevel } from '~/lib/loop/prefs';

/**
 * F11 · The Sunday Loop — the channel seam types (VIL-213 · A2). "Channels are
 * adapters": every loop feature composes ONE message model, and email/sms/push are
 * interchangeable renderers behind one `Channel` interface. The dispatch (dispatch.ts)
 * is the single place policy is enforced; a `Channel` only performs the raw send.
 *
 * Message CONTENT (the real renderers) lives with each template (B2/D1/E3) and is
 * out of A2 scope — A2 owns the interfaces + the dispatch + the ledger, and ships
 * Fakes so the policy is tested without any live provider.
 */

export type ChannelKind = 'email' | 'sms' | 'push';

/** Outbound loop taxonomy (mirrors loop_prefs categories; inbound 'reply' is A3). */
export type LoopCategory = 'weekly_plan' | 'reminder' | 'approval' | 'alert';

export type MessageUrgency = 'normal' | 'time_sensitive';

/**
 * The channel-agnostic message the dispatch receives. `payload` is per-template
 * typed by callers (opaque to the seam); `dedupeKey` is the natural-identity
 * idempotency key (e.g. `family:week:template`) that makes re-drain safe.
 */
export interface LoopMessage {
  templateKey: string;
  familyId: string;
  parentUserId: string;
  category: LoopCategory;
  urgency: MessageUrgency;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  relatedActionId?: string;
  relatedConversationId?: string;
  deepLink?: string;
}

/** Channel-specific rendered content. A2 fixes the shape; the real renderers live
 * with the templates. The SMS renderer must be segment-aware and never carry
 * health details or a child name above the family's privacy level (A5). */
export type RenderedContent =
  | { kind: 'email'; subject: string; html: string; text: string }
  | { kind: 'sms'; text: string }
  | { kind: 'push'; title: string; body: string; data?: Record<string, unknown> };

/** Produces channel-specific content for a message, honoring the resolved child-name
 * privacy level. Injected — the seam ships a Fake; templates provide the real one. */
export interface TemplateRenderer {
  render(message: LoopMessage, channel: ChannelKind, nameLevel: ChildNameLevel): RenderedContent;
}

/**
 * The outcome of a raw `Channel.send`: a provider id on success, a typed error
 * distinguishing transient (retry) from permanent (needs-reverify) failures, or a
 * skip (channel not configured / no address for this user / channel disabled).
 */
export type ChannelSendOutcome =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'skipped'; reason: 'not_configured' | 'no_address' | 'disabled' }
  | { status: 'error'; transient: boolean; code: string; message: string };

export interface Channel {
  readonly kind: ChannelKind;
  /** Send already-rendered content to a resolved parent. Policy (consent, quiet
   * hours, caps, dedupe, ledger) is the dispatch's job — a Channel never enforces
   * it, so no caller can reach a provider except through the seam. */
  send(input: { userId: string; rendered: RenderedContent }): Promise<ChannelSendOutcome>;
}
