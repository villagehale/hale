import type { Metadata } from 'next';
import { MessagesMasterDetail } from '~/components/hale/messages-master-detail';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { loadMessages } from '~/lib/messages/queries';

export const metadata: Metadata = { title: 'Messages' };

/**
 * Messages — the record of the action lifecycle a parent should see. Flag-on is
 * the portal thread (what was said, what Hale did, what's waiting). Flag-off
 * keeps the master–detail notes list. The portal module is imported only when
 * the flag is on, so the flag-off render test does not pull the trail's auth graph.
 */
export default async function MessagesPage() {
  if (receiptsIaEnabled()) {
    const { PortalMessagesPage } = await import('~/components/portal/messages-page');
    return PortalMessagesPage();
  }
  return legacyMessages();
}

async function legacyMessages() {
  const messages = await loadMessages();
  return (
    <div>
      {messages.length > 0 ? (
        <MessagesMasterDetail messages={messages} />
      ) : (
        <section className="rise rise-2 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-ink">
            Nothing new from Hale yet.
          </p>
          <p className="meta mt-4 text-ink-2">anything Hale drafts or handles will land here.</p>
        </section>
      )}
    </div>
  );
}
