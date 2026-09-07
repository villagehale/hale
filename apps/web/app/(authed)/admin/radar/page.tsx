import nextDynamic from 'next/dynamic';
import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { RadarTimeline } from '~/components/admin/radar-timeline';
import { cachedRadar, cachedWatchedSpots } from '~/lib/admin/cached';
import { supabaseTableUrl } from '~/lib/admin/links';
import {
  freshnessTone,
  minutesAgo,
  STALE_POLL_MINUTES,
  STALE_VERIFY_DAYS,
} from '~/lib/admin/panel-state';

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
  const staleDays = freshest ? Math.floor((Date.now() - freshest.getTime()) / 86_400_000) : null;
  const verifyTone = freshnessTone(staleDays, STALE_VERIFY_DAYS);
  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">
            {verifyTone === 'never' ? (
              <span className="adm-tile-fail">never</span>
            ) : verifyTone === 'stale' ? (
              <span className="adm-stale">{staleDays}d ago</span>
            ) : (
              `${staleDays}d ago`
            )}
          </div>
          <div className="adm-stat-k">
            {verifyTone === 'never' ? 'never verified' : 'freshest verify'}
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

async function WatchedSpotsBody() {
  const watched = await cachedWatchedSpots();
  const polledMinutesAgo = watched.lastPolledAt
    ? minutesAgo(watched.lastPolledAt, new Date())
    : null;
  const pollTone = freshnessTone(polledMinutesAgo, STALE_POLL_MINUTES);
  return (
    <div>
      <div className="adm-stat-row">
        <div className="adm-stat">
          <div className="adm-stat-v">{watched.live}</div>
          <div className="adm-stat-k">watched</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{watched.pending}</div>
          <div className="adm-stat-k">openings held</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">{watched.unreadable}</div>
          <div className="adm-stat-k">unreadable</div>
        </div>
        <div className="adm-stat">
          <div className="adm-stat-v">
            {pollTone === 'never' ? (
              <span className="adm-tile-fail">never</span>
            ) : pollTone === 'stale' ? (
              <span className="adm-stale">{polledMinutesAgo}m ago</span>
            ) : (
              `${polledMinutesAgo}m ago`
            )}
          </div>
          <div className="adm-stat-k">{pollTone === 'never' ? 'never polled' : 'last poll'}</div>
        </div>
        <div className="adm-stat">
          <div className={`adm-stat-v${watched.armFailures24h > 0 ? ' adm-tile-fail' : ''}`}>
            {watched.armFailures24h}
          </div>
          <div className="adm-stat-k">arm failures 24h</div>
        </div>
      </div>
      {watched.live === 0 ? <p className="adm-state">No spots are being watched.</p> : null}
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
      eyebrow: 'Watched spots',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('watched_spots') }],
      body: <WatchedSpotsBody />,
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
