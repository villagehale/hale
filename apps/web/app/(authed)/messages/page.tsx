import type { MessageView } from '~/lib/messages/mappers';
import { loadMessages } from '~/lib/messages/queries';
import { Card } from '~/components/ui/card';

/**
 * Messages — "Hale's notes to you": the family's daily digests + the action
 * lifecycle a parent should see (a draft awaiting their yes, something Hale did,
 * something that needs them), newest first. Mirrors the mobile Messages screen.
 *
 * Read-only. A drafted row is the only one that leads somewhere — the parent's
 * yes lives on Approvals (rule #4) — so it renders as a linked Card; the rest are
 * plain notes. Rule #1: teen content arrives already redacted from the loader
 * (the redacted row carries only the placeholder); this page never un-redacts.
 */

/** Only a drafted action leads somewhere — the parent decides on Approvals. */
function MessageCard({ message }: { message: MessageView }) {
  const eyebrow = <span className="eyebrow text-spruce">{message.eyebrow}</span>;
  const when = <span className="meta tabular shrink-0">{message.when}</span>;
  const body = (
    <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
      {message.body}
    </p>
  );

  if (message.actionState === 'drafted_for_approval') {
    return (
      <Card href="/approvals">
        <div className="flex items-baseline justify-between gap-3">
          {eyebrow}
          {when}
        </div>
        {body}
        <span className="link mt-4 inline-block">decide on activity →</span>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        {eyebrow}
        {when}
      </div>
      {body}
    </Card>
  );
}

export default async function MessagesPage() {
  const messages = await loadMessages();

  return (
    <div>
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">messages</h1>
        <p className="meta mt-1 text-slate-green">
          Hale&rsquo;s notes to you &mdash; your daily brief and what it&rsquo;s been doing.
        </p>
      </header>

      {messages.length > 0 ? (
        <div className="rise rise-2 grid grid-cols-1 md:grid-cols-2 gap-4">
          {messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </div>
      ) : (
        <section className="rise rise-2 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            Nothing new from Hale yet.
          </p>
          <p className="meta mt-4 text-slate-green">
            your daily brief and anything Hale drafts or handles will land here.
          </p>
        </section>
      )}
    </div>
  );
}
