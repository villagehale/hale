import { type Database, schema } from '@hale/db';
import { findRevokedChannelOwner } from '~/lib/channel/intake/channel-state';
import { claimIntakeSession, saveSession } from '~/lib/channel/intake/session';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { maskPhoneE164, normalizePhoneE164 } from '~/lib/channels/phone';
import {
  type ResolvedChannel,
  resolveVerifiedChannelByPhone,
} from '~/lib/channels/sms-consent-core';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { twilioConfig } from './config';
import {
  VOICE_GREETING,
  VOICE_GREETING_NO_TEXT,
  VOICE_RELAY_GREETING,
  VOICE_TEXT_OPENER,
} from './copy';
import { mintRelayToken } from './relay-token';
import { isValidTwilioSignature, parseTwilioParams, twilioWebhookUrl } from './signature';

/**
 * THE VOICE FRONT DOOR — what happens when somebody CALLS the number.
 *
 * Hale's number was voice-capable and unanswered from the day it was bought: a caller
 * heard Twilio's default error recording, which is the worst first impression a "quiet
 * operator you can always reach" can make. v0 fixed that by treating the call as a LEAD —
 * answer it, say Hale works by text, put a message in their thread, hang up.
 *
 * v1 changes ONE of the three branches, and only one. An enrolled parent is now
 * CONNECTED rather than texted: `<Connect><ConversationRelay>` hands the call to a
 * WebSocket where Hale actually talks (relay-session.ts). A family Hale has served for
 * months, who phones the number they already use, should not be told to go and type.
 *
 * WHO IS CALLING is still the only branch here, and the other two are byte-for-byte v0:
 *
 *   ENROLLED   — a family Hale already works for. They get a spoken conversation, in the
 *                same thread their texts run in. Nothing is sent, because nothing needs
 *                to be: they are already talking to Hale.
 *   UNSUBSCRIBED — they pressed STOP. The phone is answered, and NOTHING is sent. A call
 *                is not consent, and a re-text here is a CASL violation with a recording
 *                of us doing it (rule #1). A stopped number is not connected either —
 *                it does not resolve to a live channel, so it cannot reach the relay.
 *   A STRANGER — the cold start. They get intake's own question, verbatim, and their
 *                reply lands in the intake machine. Voice intake is deliberately NOT a
 *                thing: a stranger has consented to nothing, and the first exchange is
 *                where consent is captured.
 *
 * The order of those three is deliberate and is NOT "check the opt-out first". The live
 * channel is the answer to "may we talk to this number"; a revoked row is history, and a
 * number can hold both — a parent who stopped and started again, or a recycled number
 * with a new owner. Asking the revoked row first would silence Hale forever for whoever
 * holds the number now.
 */

/**
 * Amazon Polly's neural en-US female — warm, natural, and the safest widely-supported
 * choice on Twilio. A founder voice-pick lands as its own change; there is deliberately
 * no configuration surface for it, because one caller-facing voice is the product
 * decision and a knob would only let it drift.
 *
 * NO `language` attribute, deliberately. A Polly voice already carries its language, and
 * Twilio's `<Say>` reference warns that "combinations of voice and language not listed as
 * available may result in an error and `<Say>` instruction failure" — an attribute that
 * can only ever fail the one thing this feature exists to guarantee is an attribute worth
 * not having.
 */
const SAY_VOICE = 'Polly.Joanna-Neural';

/**
 * The relay's voice — the same Joanna, on Amazon's generative tier.
 *
 * Deliberately the same identity as the `<Say>` above: a stranger who calls and a parent
 * who calls should be talking to the same Hale, and a second voice would make the two
 * halves of one product sound like two companies. Generative rather than neural because
 * this one has to hold a CONVERSATION — the neural tier reads a line well and sounds like
 * a recording across several turns.
 *
 * No `language` attribute, for the same reason `<Say>` has none: the voice already
 * carries en-US, ConversationRelay defaults its transcription to en-US, and v1 is English
 * only. An attribute whose only possible effect is a mismatch is an attribute worth not
 * having.
 */
const RELAY_TTS_PROVIDER = 'Amazon';
const RELAY_VOICE = 'Joanna-Generative';

/** Where Twilio opens the socket. `wss`, always — Twilio refuses anything else. */
const RELAY_PATH = '/api/channels/twilio/relay';

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

/** Every outcome that ends in a spoken line and a hang-up. The relay is not one of
 * them — it ends in a document that keeps the call up (see {@link VoiceAnswer}). */
export type TwilioVoiceOutcome =
  /** A `From` we cannot canonicalize — there is nobody to text. */
  | 'invalid_number'
  /** The number pressed STOP. Answered, deliberately not texted. */
  | 'unsubscribed'
  /** A stranger: the intake conversation is open and the opener is in their thread. */
  | 'texted_cold'
  /** The claim was already held — they called again, and one text is one text. */
  | 'already_texted'
  /** The transport refused. Never folded into any of the above: those all mean a
   * message exists, and this one means a parent is still waiting (rule #11). */
  | 'send_failed';

/**
 * What answering a call decided.
 *
 * A union rather than one enum plus an optional field, because the relay answer is the
 * only one that carries something — the socket URL, which nothing else has and which the
 * caller cannot forget to read. An optional `relayUrl?: string` would compile perfectly
 * with the enrolled branch silently answered by a spoken line.
 */
export type VoiceAnswer =
  | { outcome: TwilioVoiceOutcome }
  | { outcome: 'relayed'; relayUrl: string };

/**
 * Which greeting each spoken outcome earns. A Record rather than a condition, so a new
 * outcome cannot be added without deciding what the caller hears — and the only
 * distinction that matters is whether a message is actually in their thread. Every "no"
 * says so plainly instead of promising a text that is not coming.
 */
const GREETING_FOR: Record<TwilioVoiceOutcome, string> = {
  invalid_number: VOICE_GREETING_NO_TEXT,
  unsubscribed: VOICE_GREETING_NO_TEXT,
  send_failed: VOICE_GREETING_NO_TEXT,
  texted_cold: VOICE_GREETING,
  // A second call the same day: the text really is in their thread, just not from this
  // call. Telling them to look at their messages is the true and useful answer.
  already_texted: VOICE_GREETING,
};

/**
 * Answer one authenticated call. Exported so the routing decisions are testable without
 * building an HTTP request; the request shell is {@link handleTwilioVoiceRequest}.
 */
export async function answerVoiceCall(
  deps: TwilioVoiceDeps,
  call: IncomingCall,
): Promise<VoiceAnswer> {
  const phoneE164 = normalizePhoneE164(call.from);
  if (!phoneE164) return { outcome: 'invalid_number' };

  const owner = await resolveVerifiedChannelByPhone(deps.database, phoneE164);
  if (owner) return connectEnrolledCaller(deps, owner, phoneE164, call);

  const revoked = await findRevokedChannelOwner(deps.database, phoneE164);
  if (revoked) {
    await recordCallReceived(deps.database, revoked, {
      phoneE164,
      callSid: call.callSid,
      textSent: false,
      reason: 'unsubscribed',
    });
    return { outcome: 'unsubscribed' };
  }

  return textStranger(deps, phoneE164, call);
}

/**
 * The enrolled parent's call: mint a ticket, hand Twilio a socket.
 *
 * NO transport is built and nothing is sent. That is the whole change from v0 — a parent
 * who phoned is about to be talking to Hale, and a text telling them to text would be
 * Hale interrupting itself.
 *
 * The TICKET is minted HERE, inside the branch that has already resolved WHO is calling,
 * off a request Twilio signed. That ordering is the security property: the socket never
 * has to ask the wire whose call it is holding, because the answer is in the signature it
 * was handed (relay-token.ts).
 *
 * The audit row is v0's, unchanged in shape and honest in content: a call arrived, and no
 * text went out. What happened DURING the call gets its own rows as it happens
 * (voice-record.ts) — this one is the fact that the phone rang.
 */
async function connectEnrolledCaller(
  deps: TwilioVoiceDeps,
  owner: ResolvedChannel,
  phoneE164: string,
  call: IncomingCall,
): Promise<VoiceAnswer> {
  const now = deps.now?.() ?? call.receivedAt;
  const token = mintRelayToken(
    { callSid: call.callSid, familyId: owner.familyId, parentUserId: owner.userId },
    now,
  );

  await recordCallReceived(deps.database, owner, {
    phoneE164,
    callSid: call.callSid,
    textSent: false,
    reason: 'relayed',
  });

  return {
    outcome: 'relayed',
    relayUrl: `${appBaseUrl().replace(/^http/, 'ws')}${RELAY_PATH}?t=${token}`,
  };
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
): Promise<VoiceAnswer> {
  const now = deps.now?.() ?? call.receivedAt;
  const session = await claimIntakeSession(deps.database, {
    phoneE164,
    state: 'awaiting_details',
    sourceCode: null,
  });
  if (!session) return { outcome: 'already_texted' };

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
    return { outcome: 'texted_cold' };
  } catch (err) {
    // Release it. A session left open with nothing in it costs twice: no later call
    // could ever text this number, and their own first text would skip the greeting and
    // be read as intake details they were never asked for.
    await saveSession(deps.database, session, { closedAt: now }, now);
    logSendFailure(deps, { callSid: call.callSid, sessionId: session.id, err });
    return { outcome: 'send_failed' };
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

/** An attribute VALUE, which additionally cannot contain the quote that delimits it. */
function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;');
}

function twimlResponse(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}

/** One spoken line, then the line goes down. No `<Gather>`, no recording, no voicemail:
 * the lead path collects nothing by voice, so there is nothing to consent to or retain. */
export function voiceTwiml(spoken: string): Response {
  return twimlResponse(
    `<Response><Say voice="${SAY_VOICE}">${escapeXml(spoken)}</Say><Hangup/></Response>`,
  );
}

/**
 * Hand the call to the relay socket.
 *
 * `welcomeGreeting` is Twilio's, spoken before our socket has said a word, and it is the
 * compliance disclosure (copy.ts). Putting it in the TwiML rather than as the socket's
 * first tokens is deliberate: the disclosure then does not depend on the socket
 * connecting, so a caller cannot reach a live microphone through a path where nobody told
 * them it was an AI.
 *
 * FOUR attributes and no more. There is no `record`, so no audio exists. There is no
 * `intelligenceService`, so Twilio retains no transcript of its own — the
 * `channel_messages` rows Hale writes are the only record of the conversation, which is
 * what the greeting promises and what rule #1 requires. And there is no `<Hangup/>`: the
 * call ends when the socket says `end` or the caller hangs up, not when this document is
 * read.
 */
export function conversationRelayTwiml(relayUrl: string): Response {
  const attributes = [
    `url="${escapeXmlAttribute(relayUrl)}"`,
    `welcomeGreeting="${escapeXmlAttribute(VOICE_RELAY_GREETING)}"`,
    `ttsProvider="${RELAY_TTS_PROVIDER}"`,
    `voice="${RELAY_VOICE}"`,
  ].join(' ');
  return twimlResponse(
    `<Response><Connect><ConversationRelay ${attributes} /></Connect></Response>`,
  );
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
    const answer = await answerVoiceCall(deps, {
      from,
      callSid,
      receivedAt: deps.now?.() ?? new Date(),
    });
    return answer.outcome === 'relayed'
      ? conversationRelayTwiml(answer.relayUrl)
      : voiceTwiml(GREETING_FOR[answer.outcome]);
  } catch (err) {
    // The one broad catch in this module, and it is at the boundary rather than in the
    // logic: a database blip must not turn a parent's call into an error tone. It is
    // never silent — the failure is logged, and the caller is told the truth, which is
    // that no message is coming.
    logSendFailure(deps, { callSid, err });
    return voiceTwiml(VOICE_GREETING_NO_TEXT);
  }
}
