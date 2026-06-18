import { Resend } from 'resend';
import { WaitlistWelcomeEmail } from '~/emails/waitlist-welcome';

const DEFAULT_FROM = 'hello@villagehale.com';

// The minimal Resend surface the site needs: send one email and report whether
// the provider accepted it. Injected so the waitlist route is testable without a
// live Resend account.
export interface EmailSender {
  sendWaitlistWelcome(to: string): Promise<void>;
}

/**
 * Best-effort sender. Sending the waitlist confirmation must NEVER fail the
 * signup (joining is the primary action), so failures are logged and swallowed
 * HERE, at this explicit boundary — not in business logic. An absent
 * RESEND_API_KEY is a valid, expected state in dev/preview: we skip + log,
 * we do not error.
 */
export function createEmailSender(client?: Resend): EmailSender {
  return {
    async sendWaitlistWelcome(to) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        console.info('waitlist email skipped: RESEND_API_KEY not set');
        return;
      }
      const resend = client ?? new Resend(apiKey);
      const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
      try {
        const { error } = await resend.emails.send({
          from,
          to,
          subject: "You're on the Hale waitlist",
          react: WaitlistWelcomeEmail(),
        });
        if (error) {
          console.error('waitlist email send failed', error);
        }
      } catch (err) {
        console.error('waitlist email send threw', err);
      }
    },
  };
}
