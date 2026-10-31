import { notFound } from 'next/navigation';
import { runPreviewGroupPlanConversations } from '~/lib/channel/linq/group-plan-rsvp/preview-conversation';
import { productionGroupPlanRsvpComposer } from '~/lib/channel/linq/group-plan-rsvp/voice';
import { fakeGroupPlanRsvpComposer } from '~/lib/channel/linq/group-plan-rsvp/voice-fake';

/**
 * VIL-442 Preview proof. Fake families only. No real SMS door.
 * Visible on Vercel Preview, not on production.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PreviewGroupPlanRsvpPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();

  const model = productionGroupPlanRsvpComposer();
  const conversations = await runPreviewGroupPlanConversations({
    composer: model ?? fakeGroupPlanRsvpComposer(),
  });
  const voice = model
    ? 'model'
    : 'stand-in (ANTHROPIC_API_KEY unset — not a parent-facing fallback)';

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '2rem auto',
        padding: '0 1rem',
        fontFamily: 'ui-sans-serif, system-ui',
      }}
    >
      <p style={{ letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 12 }}>
        Preview · VIL-442
      </p>
      <h1>Group RSVP for any plan</h1>
      <p>
        Fake families. No real phones. Hale speaks only at settle points. Counts are facts. Voice
        this run: {voice}. Production never sends the stand-in — a missing model is a named skip.
      </p>
      {conversations.map((conversation) => (
        <section key={conversation.id} style={{ marginTop: '2.5rem' }}>
          <h2>{conversation.title}</h2>
          <p style={{ color: '#444' }}>
            People:{' '}
            {conversation.people
              .map((person) => `${person.name}${person.haleCustomer ? '' : ' (not a Hale user)'}`)
              .join(', ')}
          </p>
          <p style={{ color: '#444' }}>Before: {conversation.beforeAfter.before}</p>
          <p style={{ color: '#444' }}>After: {conversation.beforeAfter.after}</p>
          <ul>
            {conversation.instinct.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <ol style={{ paddingLeft: 0, listStyle: 'none' }}>
            {conversation.transcript.map((line, index) => (
              <li
                key={`${conversation.id}-${index}`}
                style={{
                  margin: '0.6rem 0',
                  padding: '0.6rem 0.8rem',
                  background:
                    line.kind === 'hale' ? '#eef6f1' : line.kind === 'note' ? '#f4f4f4' : '#fff',
                  border: '1px solid #ddd',
                }}
              >
                <strong>{line.speaker}</strong>
                <div>{line.text}</div>
              </li>
            ))}
          </ol>
          {conversation.tally ? (
            <p>
              Live count facts: {conversation.tally.yesCount} yes ({conversation.tally.yesHeads}{' '}
              heads), {conversation.tally.toGo} to go
              {conversation.tally.waitingNames.length > 0
                ? ` (${conversation.tally.waitingNames.join(', ')})`
                : ''}
              .
            </p>
          ) : null}
        </section>
      ))}
    </main>
  );
}
