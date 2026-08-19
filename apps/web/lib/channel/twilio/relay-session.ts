import { VOICE_CALL_WRAP_UP, VOICE_TURN_FAILED } from './copy';
import { endSession, parseRelayMessage, spokenBeforeInterrupt, textToken } from './relay-protocol';
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

export function createRelaySession(deps: RelaySessionDeps): RelaySession {
  let ticket: RelayTicket | null = null;
  let conversationId: string | null = null;
  let refused = false;
  let ended = false;
  let turns = 0;
  let startedAt: Date | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  /** What Twilio says the caller heard before talking over Hale, for the turn that is
   * running RIGHT NOW. Cleared at the top of every turn — an interrupt is a fact about
   * one utterance, and carrying it forward would truncate the next answer to words from
   * the last one. */
  let heardBeforeInterrupt: string | null = null;
  // Turns run one at a time. Two overlapping streams would arrive at the TTS engine
  // interleaved token by token, which is not two answers — it is one unusable sentence.
  let pending: Promise<void> = Promise.resolve();

  const stopClock = (): void => {
    if (capTimer) clearTimeout(capTimer);
    capTimer = null;
  };

  const refuse = (reason: string): void => {
    if (refused) return;
    refused = true;
    deps.log.warn({ reason }, 'twilio relay: refused a socket that could not prove its call');
    deps.socket.send(endSession('unauthorized'));
    deps.socket.close();
  };

  /**
   * The one call row (rule #6), written exactly once whichever way the line went down —
   * the caller hung up, Hale did, or the platform pulled the plug.
   *
   * A socket that never authorized reaches this with no ticket, and there is no family
   * id to hang an audit row on. That is LOGGED by name rather than passed over: rule #6
   * is about calls Hale actually took, and a refused connect is not one.
   */
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
    await deps.recorder.callEnded({
      ticket: authorized,
      outcome,
      turns,
      durationMs: deps.now().getTime() - startedAt.getTime(),
      at: deps.now(),
    });
  };

  const wrapUp = (): void => {
    if (ended) return;
    deps.socket.send(textToken(VOICE_CALL_WRAP_UP, true));
    deps.socket.send(endSession('time_capped'));
    deps.socket.close();
    void finish('time_capped');
  };

  const runTurn = async (prompt: string, authorized: RelayTicket): Promise<void> => {
    if (ended) return;
    if (conversationId === null) {
      conversationId = await deps.recorder.openThread(authorized);
    }
    const thread = conversationId;
    turns += 1;
    const turnIndex = turns;
    const at = deps.now();
    await deps.recorder.callerSaid({
      ticket: authorized,
      conversationId: thread,
      text: prompt,
      turnIndex,
      at,
    });

    heardBeforeInterrupt = null;
    let composed = '';
    const emit = (token: string): void => {
      composed += token;
      deps.socket.send(textToken(token, false));
    };

    try {
      await deps.turn.respond({ prompt, ticket: authorized, conversationId: thread }, emit);
    } catch (err) {
      // The ids an operator can act on, never the words a parent said (rule #1).
      deps.log.error(
        {
          callSid: authorized.callSid,
          familyId: authorized.familyId,
          err: err instanceof Error ? err.message : String(err),
        },
        'twilio relay: turn failed — the caller hears the fixed line instead',
      );
      emit(VOICE_TURN_FAILED);
    }
    // ALWAYS. `last` is what tells Twilio the turn is over; without it a caller whose
    // turn broke sits listening to a line that never speaks again.
    deps.socket.send(textToken('', true));

    await deps.recorder.haleSaid({
      ticket: authorized,
      conversationId: thread,
      // What the caller HEARD, which is not always what Hale composed.
      text: spokenBeforeInterrupt(composed, heardBeforeInterrupt ?? ''),
      turnIndex,
      at: deps.now(),
    });
  };

  return {
    async handleMessage(raw: string): Promise<void> {
      if (refused || ended) return;
      const message = parseRelayMessage(raw);

      switch (message.type) {
        case 'setup': {
          const check = verifyRelayToken(deps.token, message.callSid, deps.now());
          if (!check.ok) {
            refuse(check.reason);
            return;
          }
          ticket = check.ticket;
          startedAt = deps.now();
          capTimer = setTimeout(wrapUp, CALL_CAP_MS);
          deps.log.info({ callSid: check.ticket.callSid }, 'twilio relay: call opened');
          return;
        }
        case 'prompt': {
          // A partial transcript: the caller has not stopped talking, and answering the
          // first half of a sentence is worse than waiting for the second.
          if (!message.last) return;
          if (!ticket) {
            refuse('no_setup');
            return;
          }
          const authorized = ticket;
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
          // hanging up on one would end a call that is still working.
          deps.log.warn(
            { callSid: ticket?.callSid ?? null, description: message.description },
            'twilio relay error: the session reported a problem and the call continues',
          );
          return;
        }
        case 'other': {
          deps.log.info(
            { callSid: ticket?.callSid ?? null, messageType: message.messageType },
            'twilio relay: message type this session takes no action on',
          );
          return;
        }
        case 'unparseable': {
          deps.log.warn(
            { callSid: ticket?.callSid ?? null },
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
