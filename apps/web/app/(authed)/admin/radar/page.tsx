import nextDynamic from 'next/dynamic';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { RadarTimeline } from '~/components/admin/radar-timeline';
import { cachedRadar } from '~/lib/admin/cached';
import { supabaseTableUrl } from '~/lib/admin/links';
import { STALE_VERIFY_DAYS } from '~/lib/admin/panel-state';

const DataTable = nextDynamic(() =>
  import('~/components/admin/data-table').then((m) => m.DataTable),
);

/** Radar — "Is the flagship's data fresh, and what opens next?" */

async function TimelineBody() {
  const radar = await cachedRadar();
  return <RadarTimeline windows={radar.upcoming} />;
}

async function FreshnessBody() {
  const radar = await cachedRadar();
  const freshest = radar.freshestVerifiedAt ? new Date(radar.freshestVerifiedAt) : null;
  const staleDays = freshest
    ? Math.floor((Date.now() - freshest.getTime()) / 86_400_000)
    : null;
  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">
            {staleDays === null ? (
              <span className="adm-tile-fail">never</span>
            ) : staleDays > STALE_VERIFY_DAYS ? (
              <span className="adm-stale">{staleDays}d ago</span>
            ) : (
              `${staleDays}d ago`
            )}
          </div>
          <div className="adm-stat-k">
            {staleDays === null ? 'never verified' : 'freshest verify'}
          </div>
        </div>
        {radar.lastVerifyRun ? (
          <>
            <div className="adm-stat">
              <div className="adm-stat-v">{radar.lastVerifyRun.checked}</div>
              <div className="adm-stat-k">checked</div>
            </div>
            <div className="adm-stat">
              <div className="adm-stat-v">{radar.lastVerifyRun.confirmed}</div>
              <div className="adm-stat-k">confirmed</div>
            </div>
            <div className="adm-stat">
              <div className="adm-stat-v">{radar.lastVerifyRun.discrepancies}</div>
              <div className="adm-stat-k">moved</div>
            </div>
          </>
        ) : null}
      </div>
      {!radar.lastVerifyRun ? <p className="adm-state">No verify sweep has run yet.</p> : null}
    </div>
  );
}

async function OutcomesBody() {
  const radar = await cachedRadar();
  if (radar.outcomes.length === 0) {
    return <p className="adm-state">No registration sequences on record.</p>;
  }
  const max = Math.max(1, ...radar.outcomes.map((o) => o.count));
  return (
    <div className="adm-barlist">
      {radar.outcomes.map((outcome) => (
        <div key={outcome.outcome} className="adm-barlist-row">
          <span className="adm-barlist-label">{outcome.outcome}</span>
          <div className="adm-barlist-track">
            <div
              className="adm-barlist-fill"
              style={{ width: `${(outcome.count / max) * 100}%` }}
            />
          </div>
          <span className="adm-num">{outcome.count}</span>
        </div>
      ))}
    </div>
  );
}

async function WindowsBody() {
  const radar = await cachedRadar();
  if (radar.upcoming.length === 0) {
    return <p className="adm-state">No upcoming registration windows on file.</p>;
  }
  return (
    <DataTable
      rows={radar.upcoming.map((w) => ({
        municipality: w.municipality,
        domain: w.programDomain.replace(/_/g, ' '),
        cycle: w.cycleLabel,
        opens: w.openAt,
        'resident opens': w.residentOpenAt,
        verified: w.verifiedAt,
      }))}
      columns={[
        { key: 'municipality', label: 'municipality' },
        { key: 'domain', label: 'domain' },
        { key: 'cycle', label: 'cycle' },
        { key: 'opens', label: 'opens', time: true },
        { key: 'resident opens', label: 'resident opens', time: true },
        { key: 'verified', label: 'verified', time: true },
      ]}
      initialSort={{ key: 'opens', desc: false }}
      filterPlaceholder="filter windows…"
    />
  );
}

export default function AdminRadarPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Opening timeline',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_windows') }],
      body: <TimelineBody />,
      span2: true,
    },
    {
      eyebrow: 'Freshness',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_windows') }],
      body: <FreshnessBody />,
    },
    {
      eyebrow: 'Outcomes',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_sequences') }],
      body: <OutcomesBody />,
    },
    {
      eyebrow: 'Upcoming windows',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_windows') }],
      body: <WindowsBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
