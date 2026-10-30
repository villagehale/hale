import type { Database } from '@hale/db';
import type { EmailSender } from '@hale/worker/executor';
import { sendGmailMessage } from '@hale/worker/gmail-send';
import { previewCaptureRequested } from '~/lib/channel/preview-capture-transport';
import {
  type GmailDraftDeps,
  productionGmailDraftDeps,
  selectGmailConnection,
} from './gmail-draft-service';
import { googleWriteScopesEnabledFor } from './google-write-flag';

/**
 * The executor's `sendEmail` port: an approved email leaves from the APPROVING
 * parent's own connected Gmail (users.messages.send), never from a Hale-owned mail
 * provider. Same gates as the Gmail draft path — the write-scope flag for this
 * parent, an active Gmail connection of theirs carrying the compose scope, a usable
 * access token — and every refusal THROWS by name (HALE_NOT_CONFIGURED) so the
 * action records a loud failure rather than a send that never happened (rule #11).
 */

export type GmailSendReaders = Pick<GmailDraftDeps, 'listGmail' | 'accessToken'> & {
  flagOn: (actorUserId: string | null) => boolean;
  send: typeof sendGmailMessage;
  /** VIL-466 · a Preview capture run. Email is refused, never sent, while it is on. */
  previewCapture?: () => boolean;
};

function notConfigured(reason: string): Error {
  const err = new Error(`HALE_NOT_CONFIGURED: ${reason}`);
  err.name = 'HaleNotConfiguredError';
  return err;
}

export function gmailEmailSender(readers: GmailSendReaders): EmailSender {
  return async (payload, context) => {
    if (!payload.to || !payload.subject || !payload.body) {
      throw new Error('send_email payload missing required fields (to, subject, body)');
    }
    if (readers.previewCapture?.()) {
      throw notConfigured('email is not sent during a Preview capture run.');
    }
    const actorUserId = context.actorUserId;
    if (!actorUserId) {
      throw notConfigured('send_email needs an approving parent to send from their Gmail.');
    }
    if (!readers.flagOn(actorUserId)) {
      throw notConfigured('Gmail sending is not enabled for this parent.');
    }
    const selected = selectGmailConnection({
      actorUserId,
      connections: await readers.listGmail(context.familyId),
    });
    if (!selected.ok) {
      throw notConfigured(
        `no usable Gmail connection for the approving parent (${selected.reason}).`,
      );
    }
    const accessToken = await readers.accessToken(selected.connection.id);
    if (!accessToken) {
      throw notConfigured("the approving parent's Gmail token is unavailable.");
    }
    const { messageId } = await readers.send(accessToken, {
      to: payload.to,
      ...(payload.cc ? { cc: payload.cc } : {}),
      subject: payload.subject,
      body: payload.body,
    });
    return { messageId, submittedAt: new Date().toISOString() };
  };
}

export function createGmailEmailSender(database: Database): EmailSender {
  const deps = productionGmailDraftDeps(database);
  return gmailEmailSender({
    listGmail: deps.listGmail,
    accessToken: deps.accessToken,
    flagOn: (actorUserId) => googleWriteScopesEnabledFor(actorUserId),
    send: sendGmailMessage,
    previewCapture: () => previewCaptureRequested(),
  });
}
