import type { FunnelCapture, FunnelSender } from './funnel';
import type { CaptureOutcome } from './server-capture';

/** Test-only: a funnel sender that records every capture and answers `outcome`. */
export function createFakeFunnelSender(outcome: CaptureOutcome = 'sent'): {
  sender: FunnelSender;
  sent: FunnelCapture[];
} {
  const sent: FunnelCapture[] = [];
  return {
    sender: {
      async send(capture) {
        sent.push(capture);
        return outcome;
      },
    },
    sent,
  };
}
