/**
 * Voice v1 — the ConversationRelay wire protocol, as pure functions.
 *
 * Twilio owns the ears and the mouth. What crosses this socket is text in both
 * directions: Twilio sends what it heard, we send what to say. Five message types come
 * in (setup, prompt, interrupt, dtmf, error) and we answer with two (text, end).
 *
 * Parsing lives here, apart from the session loop, because it is the half that can be
 * proven without a socket, a call, or a model — and because the half that CAN'T be must
 * not also be the half deciding what a message means.
 *
 * NOTHING IS SILENTLY DROPPED. A type this loop does not act on comes back as `other`
 * with its name, and unreadable bytes come back as `unparseable`. Twilio adds message
 * types; a `default: return` would make the day it does look exactly like a quiet call
 * (rule #11's shape, applied to a wire).
 */

export type RelayInbound =
  /** The first message on every socket: the call this connection belongs to. */
  | { type: 'setup'; callSid: string }
  /** What the caller said. `last` is false while they are still talking. */
  | { type: 'prompt'; voicePrompt: string; last: boolean }
  /** The caller spoke over Hale. The utterance is how much of OUR turn they heard. */
  | { type: 'interrupt'; utteranceUntilInterrupt: string }
  | { type: 'dtmf'; digit: string }
  /** Twilio's own session error. Non-fatal by default — see the session loop. */
  | { type: 'error'; description: string }
  /** A real ConversationRelay message this loop takes no action on. */
  | { type: 'other'; messageType: string }
  /** Not a message we can read at all. */
  | { type: 'unparseable' };

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseRelayMessage(raw: string): RelayInbound {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { type: 'unparseable' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { type: 'unparseable' };
  }

  const message = body as Record<string, unknown>;
  switch (message.type) {
    case 'setup': {
      const callSid = asString(message.callSid);
      return callSid ? { type: 'setup', callSid } : { type: 'unparseable' };
    }
    case 'prompt': {
      const voicePrompt = asString(message.voicePrompt);
      return voicePrompt === null
        ? { type: 'unparseable' }
        : { type: 'prompt', voicePrompt, last: message.last === true };
    }
    case 'interrupt': {
      return {
        type: 'interrupt',
        utteranceUntilInterrupt: asString(message.utteranceUntilInterrupt) ?? '',
      };
    }
    case 'dtmf': {
      const digit = asString(message.digit);
      return digit === null ? { type: 'unparseable' } : { type: 'dtmf', digit };
    }
    case 'error': {
      return { type: 'error', description: asString(message.description) ?? '' };
    }
    default: {
      const messageType = asString(message.type);
      return messageType === null ? { type: 'unparseable' } : { type: 'other', messageType };
    }
  }
}

/**
 * One chunk of Hale's answer, on its way to be spoken.
 *
 * `last: true` is what tells Twilio the turn is over and it may stop waiting; a stream
 * that ends without it leaves the caller listening to silence. Tokens go out exactly as
 * the model produced them — no trimming, no re-chunking — because the TTS engine is
 * assembling a sentence and a chunk boundary we invented is a pause the caller hears.
 */
export function textToken(token: string, last: boolean): string {
  return JSON.stringify({ type: 'text', token, last });
}

/** Hang up, saying why. The reason is an enum, never a sentence about a family —
 * Twilio stores `handoffData` and hands it to the status callback (rule #1). */
export function endSession(reasonCode: string): string {
  return JSON.stringify({ type: 'end', handoffData: JSON.stringify({ reasonCode }) });
}

/**
 * What the caller actually heard of a turn Hale was cut off in the middle of.
 *
 * The thread has to record the conversation that happened, not the one Hale composed:
 * a parent who interrupted after four words and later reads a paragraph in their thread
 * is reading something nobody said. Twilio reports the spoken prefix; when it reports
 * none (an interrupt before the first word), the whole turn stands, because a stored
 * empty turn would be a message with no content at all.
 */
export function spokenBeforeInterrupt(composed: string, utteranceUntilInterrupt: string): string {
  return utteranceUntilInterrupt.trim() === '' ? composed : utteranceUntilInterrupt;
}
