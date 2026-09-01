import nextDynamic from 'next/dynamic';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedGrowth, cachedTextingByHour, cachedTextingTrends } from '~/lib/admin/cached';
import { supabaseTableUrl } from '~/lib/admin/links';
import { EMPTY_WINDOW_LINE } from '~/lib/admin/panel-state';

// Chart islands are code-split off the server payload — this route only.
const TrendChart = nextDynamic(() =>
  import('~/components/admin/trend-chart').then((m) => m.TrendChart),
);
const BarsChart = nextDynamic(() =>
  import('~/components/admin/bars-chart').then((m) => m.BarsChart),
);
const TextingHeatmap = nextDynamic(() =>
  import('~/components/admin/texting-heatmap').then((m) => m.TextingHeatmap),
);

/** Engagement — "Are families using Hale, and when?" */

async function TextingBody() {
  const rows = await cachedTextingTrends();
  if (rows.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <TrendChart rows={rows} />;
}

async function HeatmapBody() {
  const rows = await cachedTextingByHour();
  if (rows.length === 0) return <p className="adm-state">{EMPTY_WINDOW_LINE}</p>;
  return <TextingHeatmap rows={rows} />;
}

async function GrowthBody() {
  const growth = await cachedGrowth();
  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">{growth.total}</div>
          <div className="adm-stat-k">families</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{growth.foundingCount}</div>
          <div className="adm-stat-k">founding</div>
        </div>
        {growth.tiers.map((tier) => (
          <div key={tier.tier} className="adm-stat">
            <div className="adm-stat-v">{tier.count}</div>
            <div className="adm-stat-k">{tier.tier}</div>
          </div>
        ))}
      </div>
      <BarsChart
        rows={growth.days.map((d) => ({ day: d.day, value: d.families }))}
        name="new families"
        height={150}
        cumulativeTotal={growth.total}
        cumulativeName="all families"
      />
    </div>
  );
}

export default function AdminEngagementPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Texting',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') }],
      body: <TextingBody />,
      span2: true,
    },
    {
      eyebrow: 'When families text',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('channel_messages') }],
      body: <HeatmapBody />,
    },
    {
      eyebrow: 'Growth',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('families') }],
      body: <GrowthBody />,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
