/** Gmail's own system labels for the parent's side of the mailbox. */
const GMAIL_DRAFT_LABEL = 'DRAFT';
const GMAIL_SENT_LABEL = 'SENT';

/**
 * Mail the PARENT wrote, by Gmail's labels and never by the From header: SENT is Gmail's
 * record that this account sent it (send-as aliases and notes-to-self included), DRAFT an
 * unsent draft (each autosave is a new message id). One answer for the sync, which keeps
 * this mail out of ingestion, and for the alert lane, which refuses it again.
 */
export function parentsOwnMail(labelIds: readonly string[]): 'draft' | 'own_mail' | null {
  if (labelIds.includes(GMAIL_DRAFT_LABEL)) return 'draft';
  if (labelIds.includes(GMAIL_SENT_LABEL)) return 'own_mail';
  return null;
}
