import nextDynamic from 'next/dynamic';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedDbErrors, cachedErrorClasses, cachedTextingTrends, cachedTwilioAlerts } from '~/lib/admin/cached';
import { groupTwilioClasses } from '~/lib/admin/queries/error-classes';
import { supabaseTableUrl, TWILIO_ERROR_LOGS_URL } from '~/lib/admin/links';
import { EMPTY_WINDOW_LINE, serviceStateLine } from '~/lib/admin/panel-state';

const ErrorClassList = nextDynamic(() =>
  import('~/components/admin/error-class-list').then((m) => m.ErrorClassList),
);
const DeliveryHealthChart = nextDynamic(() =>
  import('~/components/admin/trend-chart').then((m) => m.DeliveryHealthChart),
);

/** Operations — "What's failing, how often, and is it new?" Classes are the
 * landing; the raw rows are the drill-down. */

async function ClassesBody() {
  const [classes, dbErrors, twilio] = await Promise.all([
    cachedErrorClasses(),
    cachedDbErrors(),
    cachedTwilioAlerts(),
  ]);
  const twilioClasses = twilio.ok ? groupTwilioClasses(twilio.data) : [];
  const rawRows = [...dbErrors, ...(twilio.ok ? twilio.data : [])].sort((a, b) =>
    a.at < b.at ? 1 : -1,
  );
  return (
    <div>
      {!twilio.ok ? <p className="adm-state">{serviceStateLine('Twilio', twilio)}</p> : null}
      <ErrorClassList classes={[...classes, ...twilioClasses]} rawRows={rawRows} />
    </div>
  );
}

async function DeliveryHealthBody() {
  const rows = await cachedTextingTrends();
  if (rows.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <DeliveryHealthChart rows={rows} />;
}

export default function AdminOperationsPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Failure classes',
      links: [
        { label: 'Open in Twilio', href: TWILIO_ERROR_LOGS_URL },
        { label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') },
      ],
      body: <ClassesBody />,
      span2: true,
    },
    {
      eyebrow: 'Delivery health — failed-send rate',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') }],
      body: <DeliveryHealthBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
