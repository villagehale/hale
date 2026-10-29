import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { linqApiKey, linqFromE164 } from '~/lib/channel/linq/config';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';

/**
 * Preview-only capture door for fake-family proof runs.
 *
 * On only when VERCEL_ENV is exactly `preview` AND PREVIEW_CAPTURE_TRANSPORT is
 * exactly `on`. It records each send and never touches the network. It will not
 * start when any Linq key or line is configured, so a capture run can never sit
 * beside a real phone door.
 *
 * Nothing sets the flag in this tree, and the module seeds no families. The
 * deployed door persists each capture (preview-capture-store.ts) so a proof run
 * can be read back word for word; the sink here is the seam for that.
 */
type Env = Readonly<Record<string, string | undefined>>;

export type CapturedSend = OutboundMessage & { capturedAt: string; providerMessageId: string };

export class PreviewCaptureRefused extends Error {
  constructor(
    readonly reason: 'not_preview' | 'flag_off' | 'linq_configured' | 'recipient_not_synthetic',
  ) {
    super(`preview capture transport refused: ${reason}`);
    this.name = 'PreviewCaptureRefused';
  }
}

export function previewCaptureRequested(env: Env = process.env): boolean {
  return env.PREVIEW_CAPTURE_TRANSPORT?.trim() === 'on';
}

const captured: CapturedSend[] = [];

/** Every send captured in this process, oldest first. */
export function capturedSends(): readonly CapturedSend[] {
  return captured;
}

export function clearCapturedSends(): void {
  captured.length = 0;
}

/** The refusals every capture door runs before it records anything. */
function assertCaptureAllowed(env: Env): void {
  if (env.VERCEL_ENV !== 'preview') throw new PreviewCaptureRefused('not_preview');
  if (!previewCaptureRequested(env)) throw new PreviewCaptureRefused('flag_off');
  if (linqApiKey() !== null || linqFromE164() !== null) {
    throw new PreviewCaptureRefused('linq_configured');
  }
}

export function createPreviewCaptureTransport(
  env: Env = process.env,
  sink: (send: CapturedSend) => void | Promise<void> = () => {},
): ChannelTransport {
  assertCaptureAllowed(env);
  let counter = 0;
  return {
    async send(input) {
      // Only the fictional +1 437-555 fake-family range is captured. Any other
      // recipient is refused before it is recorded, so no real parent's words
      // are ever stored in plaintext by a proof run.
      if (!isSyntheticProbeNumber(input.to)) {
        throw new PreviewCaptureRefused('recipient_not_synthetic');
      }
      counter += 1;
      const send: CapturedSend = {
        ...input,
        capturedAt: new Date().toISOString(),
        providerMessageId: `preview-capture-${Date.now()}-${counter}`,
      };
      captured.push(send);
      await sink(send);
      console.info({ to: input.to, captured: true }, 'outbound: preview capture, not sent');
      return { providerMessageId: send.providerMessageId };
    },
  };
}

/**
 * A chat-addressed Linq call (a group or 1:1 message, a link, a reaction, a new
 * group, a roster change, typing, a contact card, a poll) captured instead of sent.
 * `op` names the Linq call it stands in for; `input` is what the caller passed,
 * minus any `fetch`.
 */
export type CapturedChatOp = {
  op: string;
  input: Record<string, unknown>;
  capturedAt: string;
  providerMessageId: string;
};

const capturedOps: CapturedChatOp[] = [];

/** Every chat-addressed call captured in this process, oldest first. */
export function capturedChatOps(): readonly CapturedChatOp[] {
  return capturedOps;
}

export function clearCapturedChatOps(): void {
  capturedOps.length = 0;
}

let opCounter = 0;

/**
 * Record one chat-addressed call. Runs the same refusals as
 * {@link createPreviewCaptureTransport}, every call, so it never records beside
 * a configured Linq door or outside preview.
 */
export function capturePreviewChatOp(
  op: string,
  input: Record<string, unknown>,
  env: Env = process.env,
): CapturedChatOp {
  assertCaptureAllowed(env);
  opCounter += 1;
  const { fetch: _fetch, ...rest } = input;
  const entry: CapturedChatOp = {
    op,
    input: rest,
    capturedAt: new Date().toISOString(),
    providerMessageId: `preview-capture-${op}-${Date.now()}-${opCounter}`,
  };
  capturedOps.push(entry);
  console.info({ op, captured: true }, 'outbound: preview capture, not sent');
  return entry;
}
