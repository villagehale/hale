import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural tripwire for the VIL-331 invariant: NO inbound provider webhook route
 * exists outside the failure boundary (the edge-bundle-split.test.ts pattern, pointed
 * at a different invariant).
 *
 * The boundary (`withWebhookFailureAlert`) is what turns a 2026-08-28-style outage —
 * the first DB call throwing on every inbound message for six hours — into a founder
 * page instead of an anonymous 500. The Twilio doors got it when it was built; the
 * email door shipped without it, and nothing failed anywhere: the routes are shells
 * vitest never imports, so the only thing that can hold the invariant is reading them.
 *
 * Each route must wrap its handler body — dependency construction included — so a
 * throw during construction is inside the boundary too, which is exactly where the
 * original incident threw.
 */

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/** Every provider-facing webhook door, and the route token it must alert under. */
const WEBHOOK_DOORS: ReadonlyArray<{ file: string; route: string }> = [
  { file: 'app/api/channels/twilio/inbound/route.ts', route: 'twilio_inbound' },
  { file: 'app/api/channels/twilio/voice/route.ts', route: 'twilio_voice' },
  { file: 'app/api/channels/twilio/status/route.ts', route: 'twilio_status' },
  { file: 'app/api/channels/email/inbound/route.ts', route: 'email_inbound' },
];

describe('inbound webhook doors sit inside the failure boundary', () => {
  for (const door of WEBHOOK_DOORS) {
    it(`${door.route} wraps its handler in withWebhookFailureAlert`, () => {
      const source = readFileSync(`${WEB_ROOT}/${door.file}`, 'utf8');
      expect(source).toMatch(/from '~\/lib\/channel\/twilio\/alert'/);
      // The wrapper call itself, under this door's own route token — `return
      // withWebhookFailureAlert('<route>', ...)` — so unwrapping the handler or
      // renaming its token both fail here.
      expect(source).toMatch(
        new RegExp(String.raw`return withWebhookFailureAlert\(\s*'${door.route}'`),
      );
    });
  }

  /** Positive control for the pattern (negative/structural assertions fail open): the
   * regex above must actually reject a bare, unwrapped handler. */
  it('the wrap pattern rejects an unwrapped handler', () => {
    const unwrapped = 'export async function POST(req: Request) { return handle(req); }';
    expect(unwrapped).not.toMatch(/return withWebhookFailureAlert\(\s*'email_inbound'/);
  });
});
