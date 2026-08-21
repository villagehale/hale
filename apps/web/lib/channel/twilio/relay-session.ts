import { captureAgentError } from '~/lib/analytics/server-capture';
import { VOICE_CALL_WRAP_UP, VOICE_TURN_FAILED } from './copy';
import {
  type RelayInbound,
  endSession,
  parseRelayMessage,
  spokenBeforeInterrupt,
  textToken,
} from './relay-protocol';
import { type RelayTicket, verifyRelayToken } from './relay-token';

/**
 * Voice v1 — one call, as a state machine over the ConversationRelay socket.
 *
 * The socket is the only place in Hale where a caller's words arrive on a connection
 * nobody signed, so this module's first job is not conversation, it is refusal: until a
 * `setup` message has been matched against the ticket in the URL, nothing here composes
 * anything, reads anything, or knows which family it is talking to. The identity comes
 * out of the SIGNED ticket (relay-token.ts), never off the wire — the socket cannot be
 * told who is calling, it can only be shown a signature.
 *
 * A signature is not enough on its own, because the ticket is a bearer string in a url a
 * third party logs. It must also be UNSPENT: the setup that opens a call claims it
 * durably (relay-claim.ts), so the second socket to present the same ticket is refused
 * before a thread is opened, on whichever instance it lands.
 *
 * Everything expensive is a PORT. The turn that costs a model call and the recorder that
 * writes rows are both injected, so the gate, the ordering, the interrupt truncation and
 * the cap are provable without a socket, a call, a database or Anthropic. The production
 * wiring lives in relay-deps.ts.
 */

/** The two things this session does to a WebSocket, and nothing else. */
export interface RelaySocket {
  send(frame: string): void;
  close(): void;
}

export interface VoiceTurnInput {
  prompt: string;
  ticket: RelayTicket;
  /** The parent's one long-lived thread — the same one their texts run in. */
  conversationId: string;
}

export interface VoiceTurnStream {
  /**
   * Compose one spoken answer, calling `emit` with each token as it arrives.
   *
   * Streaming rather than returning a string because the caller is listening in real
   * time: a turn that resolves with a finished paragraph is a turn the parent waits out
   * in silence. A throw is a FAILED turn — the session owns what happens next.
   */
  respond(input: VoiceTurnInput, emit: (token: string) => void): Promise<void>;
}

/** How a call finished. Only the two a call can actually reach — a socket that never
 * authorized has no family to write a row against, and says so in the log instead. */
export type VoiceCallOutcome = 'completed' | 'time_capped';

export interface VoiceTurnRecord {
  ticket: RelayTicket;
  conversationId: string;
  text: string;
  /** 1-based, in the order the call actually went. */
  turnIndex: number;
  at: Date;
}

/**
 * Everything a call leaves behind. Non-nullable (rule #11): a voice conversation that
 * writes nothing is a parent talking to something with no memory and no receipts, and
 * "no recorder wired" is not a state this session may be in.
 */
export interface VoiceCallRecorder {
  /** The one long-lived thread this parent's texts and calls share. */
  openThread(ticket: RelayTicket): Promise<string>;
  callerSaid(record: VoiceTurnRecord): Promise<void>;
  haleSaid(record: VoiceTurnRecord): Promise<void>;
  /** One immutable row for the call itself (rule #6). */
  callEnded(record: {
    ticket: RelayTicket;
    outcome: VoiceCallOutcome;
    turns: number;
    durationMs: number;
    at: Date;
  }): Promise<void>;
}

export interface RelaySessionDeps {
  socket: RelaySocket;
  /** The ticket off the query string, or null when the URL carried none. */
  token: string | null;
  turn: VoiceTurnStream;
  recorder: VoiceCallRecorder;
  /**
   * Spend this call's ticket, durably: true for the first socket to present it, false
   * for every one after.
   *
   * A separate port from the recorder because it answers a different question at a
   * different time — "may this connection be here at all", before anything of the
   * family's has been touched — and because it must survive the instance. Required,
   * never nullable (rule #11): a session that cannot claim a call is a session that
   * cannot tell a replay from the real thing, and that is not a state this may be in.
   */
  claimCall(ticket: RelayTicket, at: Date): Promise<boolean>;
  /** Required, never nullable (rule #11): every refusal and every broken turn on this
   * socket is invisible otherwise — there is no HTTP status a caller could see. */
  log: Pick<Console, 'error' | 'warn' | 'info'>;
  now(): Date;
}

export interface RelaySession {
  handleMessage(raw: string): Promise<void>;
  /** The socket closed — for any reason, including Hale hanging up. */
  handleClose(): Promise<void>;
}

/**
 * How long one call may run. Nine minutes, for two reasons that happen to agree: the
 * platform's own ceiling is 800 seconds and being cut off mid-sentence by it is a worse
 * experience than being wound up politely, and a call costs roughly eight cents a minute
 * all-in, which is a number that should have a bound somebody chose.
 */
export const CALL_CAP_MS = 9 * 60 * 1000;

/**
 * How long a socket may stay open without proving whose call it is.
 *
 * Twilio's `setup` is the first thing down the wire and arrives in milliseconds, so ten
 * seconds is generous for a real call and useless to anyone else. Without it an
 * unauthenticated peer can simply say nothing and hold a function instance to the
 * platform's 800-second ceiling, which costs money and a slot and never appears as a
 * refusal anywhere.
 */
export const PRE_AUTH_IDLE_MS = 10_000;

export function createRelaySession(deps: RelaySessionDeps): RelaySession {
  let ticket: RelayTicket | null = null;
  let conversationId: string | null = null;
  let refused = false;
  let ended = false;
  let turns = 0;
  let startedAt: Date | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  /** Armed the moment the socket opens; disarmed by the setup that proves the call. */
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  /** What Twilio says the caller heard before talking over Hale, for the turn that is
   * running RIGHT NOW. Cleared at the top of every turn — an interrupt is a fact about
   * one utterance, and carrying it forward would truncate the next answer to words from
   * the last one. */
  let heardBeforeInterrupt: string | null = null;
  // Turns run one at a time. Two overlapping streams would arrive at the TTS engine
  // interleaved token by token, which is not two answers — it is one unusable sentence.
  let pending: Promise<void> = Promise.resolve();

  const clearAuthDeadline = (): void => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
  };

  const stopClock = (): void => {
    if (capTimer) clearTimeout(capTimer);
    capTimer = null;
    clearAuthDeadline();
  };

  /**
   * Hang up on a socket that has not proved whose call it is.
   *
   * The log carries the REASON, the frame's TYPE and its SIZE, and nothing else. Every
   * other field on a pre-auth frame was written by whoever opened the socket, and an
   * operator's log is not a place to quote an unauthenticated stranger (rule #1). One
   * line per socket, too: `refused` latches, so a peer cannot turn a stream of frames
   * into a stream of log lines.
   */
  const refuse = (
    reason: string,
    frame: { type: RelayInbound['type']; bytes: number } | null,
  ): void => {
    if (refused) return;
    refused = true;
    stopClock();
    deps.log.warn(
      { reason, frame: frame?.type ?? null, bytes: frame?.bytes ?? null },
      'twilio relay: refused a socket that could not prove its call',
    );
    // A refusal has no HTTP status anybody sees and no family to hang an audit row on
    // (this runs BEFORE the ticket is proved), so the log line was the only trace it
    // ever left. The reason is an enum; nothing the peer wrote travels with it. The rate
    // is the point: `bad_signature` climbing is somebody probing, `claim_unavailable`
    // climbing is our database.
    void captureAgentError({ lane: 'relay', reason, familyId: null });
    deps.socket.send(endSession('unauthorized'));
    deps.socket.close();
  };

  authTimer = setTimeout(() => refuse('idle_no_setup', null), PRE_AUTH_IDLE_MS);

  /**
   * The one call row (rule #6), written exactly once whichever way the line went down —
   * the caller hung up, Hale did, or the platform pulled the plug.
   *
   * A socket that never authorized reaches this with no ticket, and there is no family
   * id to hang an audit row on. That is LOGGED by name rather than passed over: rule #6
   * is about calls Hale actually took, and a refused connect is not one.
   */
  /** The ids an operator can act on, never the words a parent said (rule #1). */
  const logFailure = (authorized: RelayTicket | null, err: unknown, message: string): void => {
    deps.log.error(
      {
        callSid: authorized?.callSid ?? null,
        familyId: authorized?.familyId ?? null,
        err: err instanceof Error ? err.message : String(err),
      },
      message,
    );
  };

  const finish = async (outcome: VoiceCallOutcome): Promise<void> => {
    if (ended) return;
    ended = true;
    stopClock();
    const authorized = ticket;
    if (!authorized || !startedAt) {
      deps.log.warn(
        { reason: 'no_authorized_call' },
        'twilio relay: socket closed before it proved a call — no audit row is owed or possible',
      );
      return;
    }
    try {
      await deps.recorder.callEnded({
        ticket: authorized,
        outcome,
        turns,
        durationMs: deps.now().getTime() - startedAt.getTime(),
        at: deps.now(),
      });
    } catch (err) {
      // The call is already over and there is nobody left to tell, so the only thing a
      // throw here could do is crash the instance out from under a socket that may still
      // be serving other calls. It is LOUD instead: a missing rule #6 row is a real gap
      // and an operator has to be able to see it.
      logFailure(authorized, err, 'twilio relay: the call happened but its audit row did not');
    }
  };

  const wrapUp = (): void => {
    if (ended) return;
    deps.socket.send(textToken(VOICE_CALL_WRAP_UP, true));
    deps.socket.send(endSession('time_capped'));
    deps.socket.close();
    void finish('time_capped');
  };

  /**
   * One turn, in two phases, and NEITHER of them may throw.
   *
   * A rejection here does not just lose one answer. It rejects `pending`, and every later
   * prompt is chained onto that — so one database blip mid-call would silence the rest of
   * the conversation while the caller kept talking into a line that had stopped
   * answering. It also escapes as an unhandled rejection in the socket's message
   * listener, which on this runtime takes the whole instance down.
   *
   * SPEAKING comes first and is fail-closed to the fixed line: whatever broke — the
   * thread, the ledger, the model — the caller hears something rather than dead air.
   * RECORDING comes second and is best-effort by construction: the words are already out
   * of a speaker, and there is nothing a failure here can do about that except be loud.
   */
  const runTurn = async (prompt: string, authorized: RelayTicket): Promise<void> => {
    if (ended) return;

    heardBeforeInterrupt = null;
    let composed = '';
    const emit = (token: string): void => {
      composed += token;
      deps.socket.send(textToken(token, false));
    };
    let thread: string | null = null;
    let turnIndex = 0;

    try {
      if (conversationId === null) {
        conversationId = await deps.recorder.openThread(authorized);
      }
      thread = conversationId;
      turns += 1;
      turnIndex = turns;
      await deps.recorder.callerSaid({
        ticket: authorized,
        conversationId: thread,
        text: prompt,
        turnIndex,
        at: deps.now(),
      });
      await deps.turn.respond({ prompt, ticket: authorized, conversationId: thread }, emit);
    } catch (err) {
      logFailure(
        authorized,
        err,
        'twilio relay: turn failed — the caller hears the fixed line instead',
      );
      emit(VOICE_TURN_FAILED);
    }
    // ALWAYS. `last` is what tells Twilio the turn is over; without it a caller whose
    // turn broke sits listening to a line that never speaks again.
    deps.socket.send(textToken('', true));

    // No thread means the failure was before there was anywhere to write. Nothing was
    // recorded, and the log above already says so.
    if (thread === null) return;
    try {
      await deps.recorder.haleSaid({
        ticket: authorized,
        conversationId: thread,
        // What the caller HEARD, which is not always what Hale composed.
        text: spokenBeforeInterrupt(composed, heardBeforeInterrupt ?? ''),
        turnIndex,
        at: deps.now(),
      });
    } catch (err) {
      logFailure(authorized, err, 'twilio relay: Hale said this out loud and it was not recorded');
    }
  };

  return {
    async handleMessage(raw: string): Promise<void> {
      if (refused || ended) return;
      const message = parseRelayMessage(raw);

      if (message.type === 'setup') {
        // A call that is already open. Twilio sends setup once, so a second one is a
        // frame this session has no use for — and acting on it would be worse than
        // ignoring it twice over: re-claiming would lose to THIS call's own claim and
        // hang up on a caller mid-sentence, and re-arming the cap would hand a caller
        // a clock they can restart forever.
        if (ticket) {
          deps.log.info(
            { callSid: ticket.callSid },
            'twilio relay: a repeat setup on an open call changes nothing',
          );
          return;
        }
        const check = verifyRelayToken(deps.token, message.callSid, deps.now());
        if (!check.ok) {
          refuse(check.reason, { type: message.type, bytes: Buffer.byteLength(raw) });
          return;
        }
        // The signature says the ticket is authentic; the claim says it has not been
        // spent. Both, before a single row of this family's is read — a replayed ticket
        // must not get as far as having a thread opened for it.
        let claimed: boolean;
        try {
          claimed = await deps.claimCall(check.ticket, deps.now());
        } catch (err) {
          // Fail CLOSED. Everything past this point is a real family's conversation,
          // and a call Hale cannot prove is being taken for the first time is not one
          // it may take. (The turn would break on the same database anyway.)
          logFailure(check.ticket, err, 'twilio relay: the claim on this call could not be made');
          refuse('claim_unavailable', { type: message.type, bytes: Buffer.byteLength(raw) });
          return;
        }
        if (!claimed) {
          refuse('replayed', { type: message.type, bytes: Buffer.byteLength(raw) });
          return;
        }
        ticket = check.ticket;
        clearAuthDeadline();
        startedAt = deps.now();
        capTimer = setTimeout(wrapUp, CALL_CAP_MS);
        deps.log.info({ callSid: check.ticket.callSid }, 'twilio relay: call opened');
        return;
      }

      /**
       * Everything else requires a call. Until the setup above has run, this socket is
       * an anonymous peer that has proved nothing, so no other frame it sends is acted
       * on, logged in its own words, or allowed to keep the line — the connection is
       * refused and closed. Twilio's first frame is always `setup`; anything else first
       * is not Twilio.
       */
      const authorized = ticket;
      if (!authorized) {
        refuse('no_setup', { type: message.type, bytes: Buffer.byteLength(raw) });
        return;
      }

      switch (message.type) {
        case 'prompt': {
          // A partial transcript: the caller has not stopped talking, and answering the
          // first half of a sentence is worse than waiting for the second.
          if (!message.last) return;
          pending = pending.then(() => runTurn(message.voicePrompt, authorized));
          return pending;
        }
        case 'interrupt': {
          // Only meaningful while a turn is streaming; between turns there is nothing to
          // truncate, and recording one would shorten the NEXT answer.
          heardBeforeInterrupt = message.utteranceUntilInterrupt;
          return;
        }
        case 'dtmf': {
          return;
        }
        case 'error': {
          // Twilio's own session errors are mostly non-fatal (64107 is a reconnect), and
          // hanging up on one would end a call that is still working. The description is
          // quoted because this socket has proved which call it is — pre-auth it never
          // gets here.
          deps.log.warn(
            { callSid: authorized.callSid, description: message.description },
            'twilio relay error: the session reported a problem and the call continues',
          );
          return;
        }
        case 'other': {
          deps.log.info(
            { callSid: authorized.callSid, messageType: message.messageType },
            'twilio relay: message type this session takes no action on',
          );
          return;
        }
        case 'unparseable': {
          deps.log.warn(
            { callSid: authorized.callSid },
            'twilio relay: unreadable frame — the socket is live and this session cannot read it',
          );
          return;
        }
      }
    },

    async handleClose(): Promise<void> {
      await finish('completed');
    },
  };
}
