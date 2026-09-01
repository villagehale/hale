import nextDynamic from 'next/dynamic';
import { IntakeFunnelClient } from '~/components/admin/intake-funnel-client';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedIntakeFunnel, cachedReplays, cachedSiteFunnel } from '~/lib/admin/cached';
import {
  posthogInsightsUrl,
  posthogReplayHomeUrl,
  posthogReplayUrl,
  supabaseTableUrl,
} from '~/lib/admin/links';
import { serviceStateLine } from '~/lib/admin/panel-state';
import { SITE_FUNNEL_DAYS } from '~/lib/admin/services/posthog';

const FunnelBars = nextDynamic(() =>
  import('~/components/admin/funnel-bars').then((m) => m.FunnelBars),
);
const DataTable = nextDynamic(() =>
  import('~/components/admin/data-table').then((m) => m.DataTable),
);

/** Funnels — "Where do prospects drop off, from site visit to provisioned family?" */

async function SiteFunnelBody() {
  const outcome = await cachedSiteFunnel();
  if (!outcome.ok) return <p className="adm-state">{serviceStateLine('PostHog', outcome)}</p>;
  return (
    <div>
      <FunnelBars stages={outcome.data} />
      {/* A PostHog-side query, deliberately not dial-driven — the caption says so. */}
      <p className="adm-state">unique visitors · last {SITE_FUNNEL_DAYS}d</p>
    </div>
  );
}

async function IntakeFunnelBody() {
  const funnel = await cachedIntakeFunnel();
  if (funnel.days.length === 0)
    return <p className="adm-state">No intake sessions in this window.</p>;
  return <IntakeFunnelClient days={funnel.days} sources={funnel.sources} />;
}

async function ReplaysBody() {
  const outcome = await cachedReplays();
  if (!outcome.ok) return <p className="adm-state">{serviceStateLine('PostHog', outcome)}</p>;
  if (outcome.data.length === 0) return <p className="adm-state">No replays yet.</p>;
  return (
    <DataTable
      rows={outcome.data.map((replay) => ({
        startedAt: replay.startedAt,
        seconds: replay.durationSeconds,
        page: replay.startUrl.replace(/^https?:\/\//, ''),
        clicks: replay.clickCount,
        href: posthogReplayUrl(replay.id),
      }))}
      columns={[
        { key: 'startedAt', label: 'started', time: true },
        { key: 'seconds', label: 'secs' },
        { key: 'page', label: 'first page', mono: true },
        { key: 'clicks', label: 'clicks' },
        { key: 'href', label: 'replay', link: true },
      ]}
      initialSort={{ key: 'startedAt', desc: true }}
      filterPlaceholder="filter replays…"
    />
  );
}

export default function AdminFunnelsPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Site funnel',
      links: [{ label: 'Open in PostHog', href: posthogInsightsUrl() }],
      body: <SiteFunnelBody />,
    },
    {
      eyebrow: 'Text intake funnel',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('sms_intake_sessions') }],
      body: <IntakeFunnelBody />,
    },
    {
      eyebrow: 'Session replays',
      links: [{ label: 'Open in PostHog', href: posthogReplayHomeUrl() }],
      body: <ReplaysBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
