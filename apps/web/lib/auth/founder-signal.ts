/**
 * The founder's account address — FOUNDER_ALERT_EMAIL, falling back to WELCOME_BCC.
 * An identifier only: the founder channel resolves his SMS row from it. Nothing is
 * mailed to it. Null when neither is set.
 */
export function founderAddress(): string | null {
  const explicit = process.env.FOUNDER_ALERT_EMAIL?.trim();
  if (explicit) {
    return explicit;
  }
  const bcc = process.env.WELCOME_BCC?.trim();
  return bcc ? bcc : null;
}
