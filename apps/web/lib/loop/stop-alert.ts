import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';
import type { EmailType } from '~/lib/cron/email-compliance';
import type { captureServerEvent } from '~/lib/analytics/server-capture';

/**
 * X1 (VIL-227) · the STOP guardrail. The ticket's rule for beta: page the founder
 * at ANY loop-category CASL unsubscribe, immediately — not batched into the weekly
 * digest. Mirrors founder-signal.ts's notifySignup exactly (same aloha@ identity,
 * same injectable-Resend-client pattern, same best-effort contract): the caller
 * (the /unsubscribe page) has already recorded the opt-out by the time this runs,
 * so a failure here must never surface as a broken unsubscribe confirmation.
 *
 * Privacy (rule #1): the alert names only the loop STREAM (an enum, e.g.
 * 'weekly_plan') — no parent email, no userId, no child content.
 */

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

export interface LoopStopNotifier {
  /** Returns true when the provider accepted the alert, false when skipped (no
   * founder address configured) or not sent (no Resend key/client). */
  notifyStop(category: EmailType): Promise<boolean>;
}

export function createLoopStopNotifier(client?: Resend): LoopStopNotifier {
  return {
    async notifyStop(category) {
      const to = founderAddress();
      if (!to) {
        return false;
      }
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        return false;
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await transport.send({
        from,
        to,
        subject: `Loop STOP: a parent unsubscribed (${category})`,
        text: `A parent just unsubscribed from the "${category}" loop stream.\n\nBeta guardrail: this pages you on every STOP. No parent or child identifying detail is included by design.`,
      });
      return !error;
    },
  };
}

function logFailure(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : 'unknown error';
  console.error(`${what} (unsubscribe unaffected)`, { message });
}

export interface LoopStopSideEffectDeps {
  founder: LoopStopNotifier;
  captureServerEvent: typeof captureServerEvent;
}

/**
 * Fires the two STOP side effects — the founder alert + the loop_stop analytics
 * event — in parallel, best-effort (never throws; the opt-out row is already
 * committed by the time this runs). The caller gates this on `firstTime` from
 * `processUnsubscribe` so a repeated click on the same link never re-fires it.
 */
export async function dispatchLoopStopSideEffects(
  input: { userId: string; category: EmailType },
  deps: LoopStopSideEffectDeps,
): Promise<void> {
  await Promise.all([
    deps.founder
      .notifyStop(input.category)
      .catch((err) => logFailure('loop stop founder alert failed', err)),
    deps
      .captureServerEvent('loop_stop', input.userId, { category: input.category })
      .catch((err) => logFailure('loop_stop analytics failed', err)),
  ]);
}
