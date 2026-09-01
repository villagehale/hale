import nextDynamic from 'next/dynamic';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedDbErrors, cachedTwilioAlerts } from '~/lib/admin/cached';
import { supabaseTableUrl, TWILIO_ERROR_LOGS_URL } from '~/lib/admin/links';
import { serviceStateLine } from '~/lib/admin/panel-state';

const DataTable = nextDynamic(() =>
  import('~/components/admin/data-table').then((m) => m.DataTable),
);

/** Operations — "What's failing, how often, and is it new?" */

async function ErrorsBody() {
  const [dbErrors, twilio] = await Promise.all([cachedDbErrors(), cachedTwilioAlerts()]);
  const rows = [...dbErrors, ...(twilio.ok ? twilio.data : [])].sort((a, b) =>
    a.at < b.at ? 1 : -1,
  );
  return (
    <div>
      {!twilio.ok ? <p className="adm-state">{serviceStateLine('Twilio', twilio)}</p> : null}
      {rows.length === 0 ? (
        <p className="adm-state">No failures in the last 30 days.</p>
      ) : (
        <DataTable
          rows={rows.map((row) => ({ ...row }))}
          columns={[
            { key: 'at', label: 'time', time: true },
            { key: 'source', label: 'source', dot: true },
            { key: 'code', label: 'code', mono: true },
            { key: 'summary', label: 'summary' },
          ]}
          initialSort={{ key: 'at', desc: true }}
          filterPlaceholder="filter errors…"
        />
      )}
    </div>
  );
}

export default function AdminOperationsPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Errors — Twilio + sends + agent runs',
      links: [
        { label: 'Open in Twilio', href: TWILIO_ERROR_LOGS_URL },
        { label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') },
      ],
      body: <ErrorsBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
