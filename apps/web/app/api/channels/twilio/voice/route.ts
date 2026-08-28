import { withWebhookFailureAlert } from '~/lib/channel/twilio/alert';
import { twilioVoiceDeps } from '~/lib/channel/twilio/deps';
import { handleTwilioVoiceRequest } from '~/lib/channel/twilio/voice';

// Node runtime: node:crypto HMAC, the Drizzle/pg writes, and the AES-GCM session
// cipher — none of which run on the edge runtime.
export const runtime = 'nodejs';

/**
 * POST /api/channels/twilio/voice — somebody CALLED Hale's number.
 *
 * A shell on purpose, like the inbound webhook: the gates, the branch and the send all
 * live in lib/channel/twilio/voice so they are unit-testable (vitest covers lib/**, not
 * app/**), and so the only thing that can differ between the tested path and the
 * deployed one is which dependencies are injected.
 *
 * Inside the same failure boundary as the inbound webhook (VIL-331): this shell reaches
 * the database too, and a caller hearing Twilio's default error message is exactly as
 * silent to us as a dropped text was.
 */
export async function POST(req: Request): Promise<Response> {
  return withWebhookFailureAlert('twilio_voice', async () =>
    handleTwilioVoiceRequest(req, twilioVoiceDeps()),
  );
}
