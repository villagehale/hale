import { notFound } from 'next/navigation';
import { runCarpoolPreviewConversations } from '~/lib/channel/linq/carpool-preview';

export const dynamic = 'force-dynamic';

/**
 * VIL-445 Preview proof. Fake families only. Production 404s.
 * Hale's lines here are the injected composer so a Preview with keys unset
 * still shows the conversation. Production voice is the model.
 */
export default function CarpoolPreviewPage() {
  if (process.env.VERCEL_ENV === 'production') notFound();
  const conversations = runCarpoolPreviewConversations();
  return (
    <main
      style={{
        maxWidth: 720,
        margin: '2rem auto',
        padding: '0 1rem',
        fontFamily: 'ui-sans-serif, system-ui',
      }}
    >
      <h1>Carpool Preview — fake families</h1>
      <p>
        Three fake families (Chen, Rivera, Shah). No real SMS, no real numbers. Left is before T16
        (flag off). Right is after (Hale reads the driver and reminds the night before).
      </p>
      {conversations.map((conversation) => (
        <section key={conversation.id} style={{ marginTop: '2.5rem' }}>
          <h2>{conversation.title}</h2>
          <p style={{ color: '#555' }}>{conversation.families.join(' · ')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <Thread title="Before" lines={conversation.before} />
            <Thread title="After" lines={conversation.after} />
          </div>
          {conversation.notes.length > 0 ? (
            <ul>
              {conversation.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </main>
  );
}

function Thread({
  title,
  lines,
}: {
  title: string;
  lines: { from: string; text: string }[];
}) {
  return (
    <div>
      <h3>{title}</h3>
      <ol style={{ paddingLeft: '1.2rem' }}>
        {lines.map((line, index) => (
          <li key={`${line.from}-${index}`}>
            <strong>{line.from}:</strong> {line.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
