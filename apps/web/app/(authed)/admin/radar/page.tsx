import { PanelGrid, type PanelSpec } from '~/components/admin/panel-grid';
import { cachedRadar } from '~/lib/admin/cached';
import { supabaseTableUrl } from '~/lib/admin/links';
import { STALE_VERIFY_DAYS } from '~/lib/admin/panel-state';

/** Radar — "Is the flagship's data fresh, and what opens next?" */

async function RadarBody() {
  const radar = await cachedRadar();
  const freshest = radar.freshestVerifiedAt ? new Date(radar.freshestVerifiedAt) : null;
  const staleDays = freshest
    ? Math.floor((Date.now() - freshest.getTime()) / 86_400_000)
    : null;
  const openFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    month: 'short',
    day: 'numeric',
  });
  return (
    <div>
      {radar.upcoming.length === 0 ? (
        <p className="adm-state">No upcoming registration windows on file.</p>
      ) : (
        <div className="adm-radar-list">
          {radar.upcoming.map((w) => (
            <div key={`${w.municipality}-${w.programDomain}-${w.cycleLabel}`} className="adm-radar-row">
              <span>
                {w.municipality} · {w.programDomain.replace(/_/g, ' ')} · {w.cycleLabel}
              </span>
              <span className="adm-num">
                {openFormat.format(new Date(w.openAt))}
                {w.residentOpenAt ? ` (res ${openFormat.format(new Date(w.residentOpenAt))})` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="adm-state">
        {staleDays === null ? (
          'never verified'
        ) : staleDays > STALE_VERIFY_DAYS ? (
          <span className="adm-stale">verified {staleDays}d ago — stale</span>
        ) : (
          `verified ${staleDays}d ago`
        )}
        {radar.lastVerifyRun
          ? ` · last sweep: ${radar.lastVerifyRun.checked} checked, ${radar.lastVerifyRun.confirmed} confirmed, ${radar.lastVerifyRun.discrepancies} moved`
          : ''}
        {radar.outcomes.length > 0
          ? ` · outcomes: ${radar.outcomes.map((o) => `${o.outcome} ${o.count}`).join(' · ')}`
          : ''}
      </p>
    </div>
  );
}

export default function AdminRadarPage() {
  const panels: PanelSpec[] = [
    {
      eyebrow: 'Radar',
      links: [{ label: 'Open in Supabase', href: supabaseTableUrl('registration_windows') }],
      body: <RadarBody />,
      span2: true,
    },
  ];
  return (
    <main className="adm-stage">
      <PanelGrid panels={panels} />
    </main>
  );
}
