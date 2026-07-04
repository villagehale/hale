import { Resend } from 'resend';

/**
 * The founder new-signup signal: an internal ops alert sent the moment a real
 * account is created (BEFORE onboarding), so the founder learns of EVERY join, not
 * just onboarding completions. It reuses the shared warm from-identity (WELCOME_FROM
 * → aloha@) and the injectable Resend client, mirroring the welcome/verification
 * senders. Best-effort by contract — the caller fires it and-forgets; a failure must
 * never block or fail sign-up.
 *
 * Privacy (rule #1): the new user's email is the ONLY payload. It rides in the
 * message envelope/body of an INTERNAL alert to Hale's own address — never logged.
 */

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

export interface FounderSignupNotifier {
  /** Emits the alert. Returns true when the provider accepted it, false when it was
   * skipped (no founder address, or no Resend key and no injected client). */
  notifySignup(email: string): Promise<boolean>;
}

/** The founder alert destination: FOUNDER_ALERT_EMAIL, falling back to the existing
 * WELCOME_BCC hook. Null when neither is set, so the signal is a clean no-op until
 * an address is configured. */
function founderAddress(): string | null {
  const explicit = process.env.FOUNDER_ALERT_EMAIL?.trim();
  if (explicit) {
    return explicit;
  }
  const bcc = process.env.WELCOME_BCC?.trim();
  return bcc ? bcc : null;
}

export function createFounderSignupNotifier(client?: Resend): FounderSignupNotifier {
  return {
    async notifySignup(email) {
      const to = founderAddress();
      if (!to) {
        return false;
      }
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        return false;
      }
      const resend = client ?? new Resend(apiKey);
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await resend.emails.send({
        from,
        to,
        subject: `New Hale signup: ${email}`,
        text: `A new account was just created on Hale.\n\n${email}`,
      });
      return !error;
    },
  };
}
