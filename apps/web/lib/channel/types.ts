import type { ResendAttachment } from '~/lib/channel/resend-transport';
import type { ChildNameLevel } from '~/lib/loop/prefs';

/**
 * F11 · The Sunday Loop — the channel seam types (VIL-213 · A2). "Channels are
 * adapters": every loop feature composes ONE message model, and email/sms are
 * interchangeable renderers behind one `Channel` interface. The dispatch (dispatch.ts)
 * is the single place policy is enforced; a `Channel` only performs the raw send.
 *
 * Message CONTENT (the real renderers) lives with each template (B2/D1/E3) and is
 * out of A2 scope — A2 owns the interfaces + the dispatch + the ledger, and ships
 * Fakes so the policy is tested without any live provider.
 *
 * VIL-229 · VOICE CONTRACT (binding): a template MAY carry a model-composed `voice`
 * on its payload/content, but that field is NULLABLE BY CONSTRUCTION and every
 * template MUST keep a deterministic fallback for each voiced slot. The renderer is
 * always `voice ? voiced(voice, facts) : deterministic(facts)` — never
 * `voiced(voice)` unconditionally. FACTS (times, dates, child names, links) stay in
 * the deterministic shell and are INJECTED into the render; the model composes only
 * the surrounding words, schema-constrained to the voice fields and lint-guarded so a
 * voiced string can carry no invented time/link (apps/web/lib/loop/voice/*). This is
 * rule #8 made structural: voice is composed at COMPOSE time (or inline at trigger),
 * NEVER at send time, and a send is never blocked on model availability — a null
 * voice renders the deterministic copy and still sends.
 */

/** The live delivery legs. The persisted channel_message_channel enum still
 * carries 'push' (and 'voice') for historical rows — this union is only what the
 * dispatch can SEND today, narrowed when the Expo push channel died (VIL-318).
 * 'whatsapp' is representable so the dispatch can REFUSE it by name: WhatsApp is a
 * REPLY pipe only (Meta's 24h session policy, reply-transport.ts) — every proactive
 * lane stays email/sms, and a whatsapp leg here is a named failed row, never a send. */
export type ChannelKind = 'email' | 'sms' | 'whatsapp';

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
  /**
   * Pins the exchange leg to ONE channel instead of the parent's loop_channel
   * (VIL-249). For the one message class whose content exists on a single channel:
   * a calendar invite IS a text/calendar attachment, so re-routing it to SMS would
   * deliver an empty sentence. Everything else leaves this unset and rides the
   * parent's loop_channel.
   */
  channel?: ChannelKind;
}

/**
 * What the composed-voice slot did on ONE render (docs/voice.md, "The two SMS folds").
 *
 * A template that composes a sentence through a model and then measures it against the
 * wire has genuinely different endings, and without names they are one silence: the
 * composer degraded and wrote nothing, the composer wrote something the fold refused, and
 * the sentence went out. The refusals are enumerated rather than lumped because each one
 * is a different bug in a different place — a dropped character is the composer's
 * charset, a question is its register, and an over-long line is a model measured against a
 * budget nobody told it about.
 *
 * ONLY ENDINGS THE RENDERERS CAN REACH ARE NAMED. A 'refused:offset_missing' was here for
 * the reminder's condition (c), and it could not happen: the fold appends the voice to a
 * body that already opens with the deterministic lead, so the check compared the fold's
 * own concatenation against its own prefix and the counter could only ever read zero. A
 * variant nothing can produce is a gate nobody is watching, so the guarantee was left
 * structural and the name removed (reminder/sms.ts).
 *
 * 'absent' means the slot EXISTS and the composer gave it nothing. A RenderedContent with
 * no outcome at all is the other thing: a message with no voice slot to begin with.
 */
export type VoiceOutcome =
  | 'used'
  | 'absent'
  /** gsmSafe would have eaten a character — the line arrives on the wire a word short. */
  | 'refused:gsm_dropped'
  /** The slot's question budget (D14): one for an ask, zero for a statement. */
  | 'refused:question_count'
  /** Composed, measured, did not fit the channel's segment budget. */
  | 'refused:over_segment';

/** Channel-specific rendered content. A2 fixes the shape; the real renderers live
 * with the templates. The SMS renderer must be segment-aware and never carry
 * health details or a child name above the family's privacy level (A5).
 *
 * `voice` is set by the renderers that HAVE a composed voice slot and is absent on every
 * other template — see {@link VoiceOutcome}. It is an enum about Hale's own pipeline and
 * never content, which is why the dispatch can carry it onto an immutable audit row. */
export type RenderedContent =
  | { kind: 'email'; subject: string; html: string; text: string; attachments?: ResendAttachment[] }
  | { kind: 'sms'; text: string; voice?: VoiceOutcome };

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
