import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { claimIntakeSession, saveSession } from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { maskPhoneE164, normalizePhoneE164 } from '~/lib/channels/phone';
import {
  type ResolvedChannel,
  resolveVerifiedChannelByPhone,
} from '~/lib/channels/sms-consent-core';
import { twilioConfig } from './config';
import {
  VOICE_GREETING,
  VOICE_GREETING_NO_TEXT,
  VOICE_TEXT_OPENER,
  VOICE_TEXT_OPENER_KNOWN,
} from './copy';
import { isValidTwilioSignature, parseTwilioParams, twilioWebhookUrl } from './signature';

/**
 * THE VOICE FRONT DOOR, v0 — what happens when somebody CALLS the number.
 *
 * Hale's number has been voice-capable and unanswered since it was bought: a caller
 * today hears Twilio's default error recording. That is the worst first impression a
 * "quiet operator you can always reach" can make, and it is free to fix.
 *
 * v0 does NOT make the call a conversation. Hale is messaging-first by decision (F14 ·
 * D1), and a voice agent is a different product with different consent, recording and
 * retention questions. So the call is treated as a LEAD: answer it, say in one breath
 * that Hale works by text, put a message in their thread, hang up. Everything after that
 * is the SMS relationship that already exists — this module starts no second one.
 *
 * WHO IS CALLING decides which text they get, and it is the only branch here:
 *
 *   ENROLLED   — a family Hale already works for. They get one line that asks for
 *                nothing; their reply reaches the coach through the hand-off in
 *                inbound.ts. Sending this caller the intake questions would be Hale
 *                asking a family it has served for months to re-introduce their
 *                children, which is the one outcome that would make this feature a
 *                regression rather than an addition.
 *   UNSUBSCRIBED — they pressed STOP. The phone is answered, and NOTHING is sent. A call
 *                is not consent, and a re-text here is a CASL violation with a recording
 *                of us doing it (rule #1).
 *   A STRANGER — the cold start. They get intake's own question, verbatim, and their
 *                reply lands in the intake machine.
 *
 * The order of those three is deliberate and is NOT "check the opt-out first". The live
 * channel is the answer to "may we text this number"; a revoked row is history, and a
 * number can hold both — a parent who stopped and started again, or a recycled number
 * with a new owner. Asking the revoked row first would silence Hale forever for whoever
 * holds the number now.
 */

/** Amazon Polly's neural en-US female — warm, natural, and the safest widely-supported
 * choice on Twilio. A founder voice-pick lands as its own change; there is deliberately
 * no configuration surface for it, because one caller-facing voice is the product
 * decision and a knob would only let it drift. */
const SAY_VOICE = 'Polly.Joanna-Neural';
const SAY_LANGUAGE = 'en-US';

/** The template behind the enrolled caller's text, recorded on the ledger row so the
 * body itself never has to be (rule #1). */
const VOICE_CALLBACK_TEMPLATE = 'voice_callback';

export interface TwilioVoiceDeps {
  database: Database;
  /**
   * Required, never nullable (rule #11): a front door that answers the phone and
   * silently sends nothing is the failure this feature exists to end. Built LAZILY for
   * the reason inbound.ts builds its intake deps lazily — a forged request must never
   * construct a provider client.
   */
  transport: () => ChannelTransport;
  /** The absence of a send is always LOGGED, never inferred from a missing row. */
  log: Pick<Console, 'error'>;
  now?: () => Date;
}

export interface IncomingCall {
  /** Twilio's `From`, in whatever shape the carrier gave it. */
  from: string;
  /** Twilio's `CallSid` — the operator's handle on this call, and nothing about a
   * family. No audio is fetched, stored, or transcribed. */
  callSid: string;
  receivedAt: Date;
}

export type TwilioVoiceOutcome =
  /** A `From` we cannot canonicalize — there is nobody to text. */
  | 'invalid_number'
  /** The number pressed STOP. Answered, deliberately not texted. */
  | 'unsubscribed'
  /** A stranger: the intake conversation is open and the opener is in their thread. */
  | 'texted_cold'
  /** An enrolled parent: the callback is in their thread and on their ledger. */
  | 'texted_known'
  /** The claim was already held — they called again, and one text is one text. */
  | 'already_texted'
  /** The transport refused. Never folded into any of the above: those all mean a
   * message exists, and this one means a parent is still waiting (rule #11). */
  | 'send_failed';

/**
 * Which greeting each outcome earns. A Record rather than a condition, so a new outcome
 * cannot be added without deciding what the caller hears — and the only distinction that
 * matters is whether a message is actually in their thread. Every "no" says so plainly
 * instead of promising a text that is not coming.
 */
const GREETING_FOR: Record<TwilioVoiceOutcome, string> = {
  invalid_number: VOICE_GREETING_NO_TEXT,
  unsubscribed: VOICE_GREETING_NO_TEXT,
  send_failed: VOICE_GREETING_NO_TEXT,
  texted_cold: VOICE_GREETING,
  texted_known: VOICE_GREETING,
  // A second call the same day: the text really is in their thread, just not from this
  // call. Telling them to look at their messages is the true and useful answer.
  already_texted: VOICE_GREETING,
};

/**
 * At most one callback per parent per day. The DAY, not a rolling 24 hours, because the
 * claim has to BE the insert — a rolling window needs a read, and read-then-insert is a
 * guard two simultaneous calls both walk through. A deterministic key hands the decision
 * to `channel_messages_dedupe_key_uniq`, where exactly one caller can win it.
 */
export function voiceCallbackDedupeKey(parentUserId: string, at: Date): string {
  return `voice_callback:${parentUserId}:${at.toISOString().slice(0, 10)}`;
}

/**
 * Answer one authenticated call. Exported so the routing decisions are testable without
 * building an HTTP request; the request shell is {@link handleTwilioVoiceRequest}.
 */
export async function answerVoiceCall(
  deps: TwilioVoiceDeps,
  call: IncomingCall,
): Promise<TwilioVoiceOutcome> {
  const phoneE164 = normalizePhoneE164(call.from);
  if (!phoneE164) return 'invalid_number';

  const owner = await resolveVerifiedChannelByPhone(deps.database, phoneE164);
  if (owner) return textEnrolledCaller(deps, owner, phoneE164, call);

  const revoked = await findRevokedChannelOwner(deps.database, phoneE164);
  if (revoked) {
    await recordCallReceived(deps.database, revoked, {
      phoneE164,
      callSid: call.callSid,
      textSent: false,
      reason: 'unsubscribed',
    });
    return 'unsubscribed';
  }

  return textStranger(deps, phoneE164, call);
}

/**
 * The enrolled parent's callback: claim, send, settle.
 *
 * The ledger row is written BEFORE the send with `status: 'queued'`, and that insert is
 * the whole idempotency mechanism — the row is the claim, not a record of a claim made
 * somewhere else. A row that loses the unique index means another call already owns
 * today's callback.
 *
 * CASL: the parent is enrolled, so this needs no special basis — but it would be a
 * direct response to their own call even if they were not (inquiry / implied consent).
 *
 * QUIET HOURS do not apply and are deliberately not consulted. The outbound gate exists
 * for messages HALE decides to send; this one is a reply to a phone call the parent is
 * still on. Holding it until 08:00 would answer a 22:00 call with silence.
 */
async function textEnrolledCaller(
  deps: TwilioVoiceDeps,
  owner: ResolvedChannel,
  phoneE164: string,
  call: IncomingCall,
): Promise<TwilioVoiceOutcome> {
  const now = deps.now?.() ?? call.receivedAt;
  const [claimed] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'sms',
      direction: 'out',
      category: 'voice',
      templateKey: VOICE_CALLBACK_TEMPLATE,
      dedupeKey: voiceCallbackDedupeKey(owner.userId, now),
      status: 'queued',
    })
    .onConflictDoNothing({
      target: schema.channelMessages.dedupeKey,
      where: sql`${schema.channelMessages.dedupeKey} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  const messageId = claimed?.id;
  if (!messageId) return 'already_texted';

  await recordCallReceived(deps.database, owner, {
    phoneE164,
    callSid: call.callSid,
    textSent: true,
    targetId: messageId,
  });

  try {
    const { providerMessageId } = await deps
      .transport()
      .send({ to: phoneE164, body: VOICE_TEXT_OPENER_KNOWN });
    await deps.database
      .update(schema.channelMessages)
      .set({ status: 'sent', providerMessageId, sentAt: now })
      .where(eq(schema.channelMessages.id, messageId));
    await deps.database.insert(schema.auditLog).values({
      familyId: owner.familyId,
      actor: owner.userId,
      actionTaken: 'voice_callback_sent',
      targetTable: 'channel_messages',
      targetId: messageId,
    });
    return 'texted_known';
  } catch (err) {
    // The claim is NOT released. A consumed key costs this parent one courtesy text they
    // can replace by texting Hale themselves, which works; releasing it would let a
    // caller who redials five times provoke five provider attempts. The stranger's claim
    // below is released because holding it costs them something they cannot route
    // around.
    await deps.database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: 'transport_error' })
      .where(eq(schema.channelMessages.id, messageId));
    logSendFailure(deps, { callSid: call.callSid, channelMessageId: messageId, err });
    return 'send_failed';
  }
}

/**
 * The stranger's opener, and the conversation it starts.
 *
 * The intake SESSION is the claim here, for two jobs at once. It is the dedupe — the
 * partial unique index allows one open conversation per number, so a second call finds
 * it taken and texts nothing. And it is the CONTINUITY: without an open session in
 * `awaiting_details`, the reply this text asks for would reach the intake machine as a
 * first contact and be answered with the greeting that asks the very same question
 * again. The claim is what makes their answer an answer.
 *
 * CASL: the caller phoned us. That inquiry is the implied consent this send rests on,
 * and the message carries the unsubscribe line that makes it one they can end.
 *
 * No audit row is written, and none can be: `audit_log.family_id` is NOT NULL and this
 * caller has no family yet. Rule #6 is satisfied where intake already satisfies it — the
 * encrypted session transcript is the record, and provisioning replays it into
 * channel_messages with its audit rows the moment there is a family to hang them on.
 */
async function textStranger(
  deps: TwilioVoiceDeps,
  phoneE164: string,
  call: IncomingCall,
): Promise<TwilioVoiceOutcome> {
  const now = deps.now?.() ?? call.receivedAt;
  const session = await claimIntakeSession(deps.database, {
    phoneE164,
    state: 'awaiting_details',
    sourceCode: null,
  });
  if (!session) return 'already_texted';

  try {
    const { providerMessageId } = await deps
      .transport()
      .send({ to: phoneE164, body: VOICE_TEXT_OPENER });
    await saveSession(
      deps.database,
      session,
      {
        transcript: [
          {
            direction: 'out',
            body: VOICE_TEXT_OPENER,
            providerId: providerMessageId,
            at: now.toISOString(),
          },
        ],
      },
      now,
    );
    return 'texted_cold';
  } catch (err) {
    // Release it. A session left open with nothing in it costs twice: no later call
    // could ever text this number, and their own first text would skip the greeting and
    // be read as intake details they were never asked for.
    await saveSession(deps.database, session, { closedAt: now }, now);
    logSendFailure(deps, { callSid: call.callSid, sessionId: session.id, err });
    return 'send_failed';
  }
}

/**
 * The call itself, on the record (rule #6). Written only where a family exists to hang
 * it on — the enrolled caller and the unsubscribed one.
 *
 * The number is MASKED. The raw value is never stored anywhere in Hale (parent_channels
 * holds a blind index and an encrypted blob), and an audit table read by a right-to-
 * access export is the last place to make an exception. No audio, no transcript, no
 * duration: the only facts here are that this number called and what Hale did about it.
 */
async function recordCallReceived(
  database: Database,
  owner: { userId: string; familyId: string },
  detail: {
    phoneE164: string;
    callSid: string;
    textSent: boolean;
    reason?: string;
    targetId?: string;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'voice_call_received',
    targetTable: detail.targetId ? 'channel_messages' : null,
    targetId: detail.targetId ?? null,
    after: {
      maskedPhone: maskPhoneE164(detail.phoneE164),
      callSid: detail.callSid,
      textSent: detail.textSent,
      ...(detail.reason ? { reason: detail.reason } : {}),
    },
  });
}

/** The ids an operator can act on, and nothing else. Twilio echoes the number and the
 * body back inside its error message, so only the shape of the failure is recorded
 * (rule #1). */
function logSendFailure(
  deps: TwilioVoiceDeps,
  detail: { callSid: string; channelMessageId?: string; sessionId?: string; err: unknown },
): void {
  deps.log.error(
    {
      callSid: detail.callSid,
      ...(detail.channelMessageId ? { channelMessageId: detail.channelMessageId } : {}),
      ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
      err: detail.err instanceof Error ? detail.err.message : String(detail.err),
    },
    'twilio voice: answered the call but could not text the caller',
  );
}

/** XML text content. `&` first, or the escapes we add would be escaped again. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One spoken line, then the line goes down. No `<Gather>`, no recording, no voicemail:
 * v0 collects nothing by voice, so there is nothing to consent to or retain. */
export function voiceTwiml(spoken: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${SAY_VOICE}" language="${SAY_LANGUAGE}">${escapeXml(spoken)}</Say><Hangup/></Response>`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

/**
 * `POST /api/channels/twilio/voice`.
 *
 * Two refusals first, in this order and before anything else happens — the same two the
 * inbound webhook makes, for the same reasons:
 *   503 — the leg is not provisioned. Nothing parsed, nothing written, no provider
 *         touched. Dark by construction rather than by a flag.
 *   403 — the signature does not match. Same: zero side effects. Anyone can POST to a
 *         public URL claiming to be Twilio and claiming to be any `From`; without this
 *         gate that is a free SMS to any number in the world, billed to Hale.
 *
 * Everything authentic answers 200 with a TwiML document, whatever happened behind it.
 * There is a human holding a phone to their ear: a 4xx or a 5xx is Twilio's error
 * recording, which is precisely the experience this feature was built to end.
 */
export async function handleTwilioVoiceRequest(
  req: Request,
  deps: TwilioVoiceDeps,
): Promise<Response> {
  const config = twilioConfig();
  if (!config) {
    return Response.json({ error: 'twilio_not_configured' }, { status: 503 });
  }

  const params = parseTwilioParams(await req.text());
  const valid = isValidTwilioSignature({
    authToken: config.authToken,
    url: twilioWebhookUrl(req),
    params,
    signature: req.headers.get('x-twilio-signature'),
  });
  if (!valid) {
    return Response.json({ error: 'invalid_signature' }, { status: 403 });
  }

  const from = params.From ?? '';
  const callSid = params.CallSid ?? '';
  if (!from || !callSid) {
    return voiceTwiml(VOICE_GREETING_NO_TEXT);
  }

  try {
    const outcome = await answerVoiceCall(deps, {
      from,
      callSid,
      receivedAt: deps.now?.() ?? new Date(),
    });
    return voiceTwiml(GREETING_FOR[outcome]);
  } catch (err) {
    // The one broad catch in this module, and it is at the boundary rather than in the
    // logic: a database blip must not turn a parent's call into an error tone. It is
    // never silent — the failure is logged, and the caller is told the truth, which is
    // that no message is coming.
    logSendFailure(deps, { callSid, err });
    return voiceTwiml(VOICE_GREETING_NO_TEXT);
  }
}
