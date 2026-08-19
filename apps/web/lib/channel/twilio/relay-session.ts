import { endSession, parseRelayMessage, textToken } from './relay-protocol';
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
 * Everything expensive is a PORT. The turn that costs a model call is injected, so the
 * gate, the ordering, and the failure behaviour are provable without a socket, a call,
 * or Anthropic. The production wiring lives in relay-deps.ts.
 */

/** The two things this session does to a WebSocket, and nothing else. */
export interface RelaySocket {
  send(frame: string): void;
  close(): void;
}

export interface VoiceTurnInput {
  prompt: string;
  ticket: RelayTicket;
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

export interface RelaySessionDeps {
  socket: RelaySocket;
  /** The ticket off the query string, or null when the URL carried none. */
  token: string | null;
  turn: VoiceTurnStream;
  /** Required, never nullable (rule #11): every refusal and every broken turn on this
   * socket is invisible otherwise — there is no HTTP status a caller could see. */
  log: Pick<Console, 'error' | 'warn' | 'info'>;
  now(): Date;
}

export interface RelaySession {
  handleMessage(raw: string): Promise<void>;
}

export function createRelaySession(deps: RelaySessionDeps): RelaySession {
  let ticket: RelayTicket | null = null;
  let refused = false;
  // Turns run one at a time. Two overlapping streams would arrive at the TTS engine
  // interleaved token by token, which is not two answers — it is one unusable sentence.
  let pending: Promise<void> = Promise.resolve();

  const refuse = (reason: string): void => {
    if (refused) return;
    refused = true;
    deps.log.warn({ reason }, 'twilio relay: refused a socket that could not prove its call');
    deps.socket.send(endSession('unauthorized'));
    deps.socket.close();
  };

  const runTurn = async (prompt: string, authorized: RelayTicket): Promise<void> => {
    try {
      await deps.turn.respond({ prompt, ticket: authorized }, (token) => {
        deps.socket.send(textToken(token, false));
      });
    } catch (err) {
      // The ids an operator can act on, never the words a parent said (rule #1).
      deps.log.error(
        {
          callSid: authorized.callSid,
          familyId: authorized.familyId,
          err: err instanceof Error ? err.message : String(err),
        },
        'twilio relay: turn failed — the caller is owed an answer this call did not give',
      );
    }
    // ALWAYS, on both paths. `last` is what tells Twilio the turn is over; without it a
    // caller whose turn broke sits listening to a line that never speaks again.
    deps.socket.send(textToken('', true));
  };

  return {
    async handleMessage(raw: string): Promise<void> {
      if (refused) return;
      const message = parseRelayMessage(raw);

      switch (message.type) {
        case 'setup': {
          const check = verifyRelayToken(deps.token, message.callSid, deps.now());
          if (!check.ok) {
            refuse(check.reason);
            return;
          }
          ticket = check.ticket;
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
  };
}
