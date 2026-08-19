import { type WebSocketData, experimental_upgradeWebSocket } from '@vercel/functions';
import { echoVoiceTurn } from '~/lib/channel/twilio/relay-echo';
import { createRelaySession } from '~/lib/channel/twilio/relay-session';

/**
 * WITHOUT THIS LINE THE SOCKET CRASHES ON THE FIRST FRAME. Found by the M0 spike, on a
 * real preview deploy — the upgrade succeeded (HTTP 101) and then the instance died with
 * `TypeError: b.unmask is not a function` and exit status 129, on every call.
 *
 * `ws` reaches for the optional native `bufferutil` addon inside a try/catch and falls
 * back to pure JS when the require throws. Next's webpack config aliases `bufferutil` to
 * `false`, which does not throw — it resolves to an empty module — so ws installs the
 * fast path over an object with no `unmask` on it and then calls it for every masked
 * frame. Every frame a WebSocket CLIENT sends is masked, so "every call" is the whole
 * population.
 *
 * `WS_NO_BUFFER_UTIL` is ws's own documented switch for exactly this: skip the addon,
 * use the JS implementation. Set here rather than in the deployment environment because
 * an env var nobody can see is a voice product that silently stops working the first
 * time somebody provisions a new environment — and set before the import that loads ws,
 * which @vercel/functions performs lazily inside the handler below. Bundling `ws` as an
 * external instead does NOT work: `serverExternalPackages: ['ws']` leaves it in the
 * bundle (tried, verified in .next/server/chunks).
 */
process.env.WS_NO_BUFFER_UTIL ??= '1';
process.env.WS_NO_UTF_8_VALIDATE ??= '1';

// Node runtime: node:crypto HMAC for the ticket, and (from M1) Drizzle writes and the
// Anthropic SDK. None of it runs on the edge runtime.
export const runtime = 'nodejs';
// A WebSocket upgrade is the least static thing a route can be. Next must never try to
// prerender it.
export const dynamic = 'force-dynamic';
// The Fluid ceiling on Pro. The session's own 9-minute cap hangs up well inside it —
// this is the platform backstop, not the product one.
export const maxDuration = 800;

/**
 * `GET /api/channels/twilio/relay` — the ConversationRelay socket.
 *
 * Twilio opens this connection itself, from the `<ConversationRelay url="wss://…">` the
 * voice webhook returned. It is NOT signed: Twilio signs webhooks, not WebSocket
 * upgrades. The authority is the ticket in the query string, minted by that same
 * signature-verified webhook and checked against the `setup` message inside the session
 * (relay-session.ts) — which is why nothing here reaches a database or a model before a
 * frame has been read.
 *
 * A shell on purpose, like every other route in this folder: the state machine lives in
 * lib/ where vitest can see it, and the only thing that differs between the tested path
 * and the deployed one is which ports are injected.
 */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('t');

  return experimental_upgradeWebSocket((ws) => {
    const session = createRelaySession({
      socket: {
        send: (frame) => ws.send(frame),
        close: () => ws.close(),
      },
      token,
      turn: echoVoiceTurn(),
      log: console,
      now: () => new Date(),
    });

    ws.on('message', (data: WebSocketData) => {
      void session.handleMessage(data.toString());
    });
  });
}
