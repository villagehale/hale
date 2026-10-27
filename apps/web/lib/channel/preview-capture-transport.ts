import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { linqApiKey, linqFromE164 } from '~/lib/channel/linq/config';

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
  constructor(readonly reason: 'not_preview' | 'flag_off' | 'linq_configured') {
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

export function createPreviewCaptureTransport(
  env: Env = process.env,
  sink: (send: CapturedSend) => void | Promise<void> = () => {},
): ChannelTransport {
  if (env.VERCEL_ENV !== 'preview') throw new PreviewCaptureRefused('not_preview');
  if (!previewCaptureRequested(env)) throw new PreviewCaptureRefused('flag_off');
  if (linqApiKey() !== null || linqFromE164() !== null) {
    throw new PreviewCaptureRefused('linq_configured');
  }
  let counter = 0;
  return {
    async send(input) {
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
