import type { captureServerEvent } from '~/lib/analytics/server-capture';
import type { EmailType } from '~/lib/cron/email-compliance';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

/**
 * X1 (VIL-227) · the STOP guardrail. A loop-category CASL unsubscribe is posted to
 * Slack #ops. The caller (the /unsubscribe page) has already recorded the opt-out
 * by the time this runs, so a failure here must never surface as a broken
 * unsubscribe confirmation.
 *
 * Privacy (rule #1): the alert names only the loop STREAM (an enum, e.g.
 * 'reminder') — no parent email, no userId, no child content.
 */

export interface LoopStopNotifier {
  /** True when Slack #ops accepted the page. */
  notifyStop(category: EmailType): Promise<boolean>;
}

export function createLoopStopNotifier(): LoopStopNotifier {
  return {
    async notifyStop(category) {
      const text = [
        `Loop STOP: a parent unsubscribed (${category})`,
        '',
        `A parent just unsubscribed from the "${category}" loop stream.`,
        'No parent or child identifying detail is included.',
      ].join('\n');
      const outcome = await postOpsSlack(text);
      return outcome === 'sent';
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
      .then((delivered) => {
        if (!delivered) {
          // Refused before it left (no founder address / no Resend key) rather than
          // thrown, so nothing here would otherwise mark a STOP nobody was paged about
          // (VIL-267). The category is an enum — no parent detail (rule #1).
          console.warn('loop stop founder alert not delivered', { category: input.category });
        }
      })
      .catch((err) => logFailure('loop stop founder alert failed', err)),
    deps
      .captureServerEvent('loop_stop', input.userId, { category: input.category })
      .catch((err) => logFailure('loop_stop analytics failed', err)),
  ]);
}
