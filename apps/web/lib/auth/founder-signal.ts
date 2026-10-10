/**
 * Where founder ops mail goes. FOUNDER_ALERT_EMAIL, falling back to WELCOME_BCC.
 * Null when neither is set, so a signal is a clean no-op until an address is
 * configured. Exported: the STOP alert and the loop-health digest reuse this
 * resolution rather than a second copy.
 *
 * The email-signup notifier that used to live here is gone with the email door.
 */
export function founderAddress(): string | null {
  const explicit = process.env.FOUNDER_ALERT_EMAIL?.trim();
  if (explicit) {
    return explicit;
  }
  const bcc = process.env.WELCOME_BCC?.trim();
  return bcc ? bcc : null;
}
