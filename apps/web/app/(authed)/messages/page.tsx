import { MessagesMasterDetail } from '~/components/hale/messages-master-detail';
import { loadMessages } from '~/lib/messages/queries';

/**
 * Messages — the record of the action lifecycle a parent should see (a draft
 * awaiting their yes, something Hale did, something that needs them), newest
 * first. Mirrors the mobile Messages screen.
 *
 * It also still renders any daily-brief rows a family accumulated, but that brief
 * is no longer composed, so the empty state must not promise one — a parent
 * arriving today would wait for something that is never coming.
 *
 * Presented as a master–detail (design handoff §4.6/§4.8): a note list beside the
 * selected note. Read-only. A drafted note is the only one that leads somewhere —
 * the parent's yes lives on Approvals (rule #4). Rule #1: teen content arrives
 * already redacted from the loader; this page never un-redacts.
 */
export default async function MessagesPage() {
  const messages = await loadMessages();

  return (
    <div>
      {/* Title + back-to-Family breadcrumb live in the shell top bar (§3.2). */}
      {messages.length > 0 ? (
        <MessagesMasterDetail messages={messages} />
      ) : (
        <section className="rise rise-2 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-ink">
            Nothing new from Hale yet.
          </p>
          <p className="meta mt-4 text-ink-2">
            anything Hale drafts or handles will land here.
          </p>
        </section>
      )}
    </div>
  );
}
