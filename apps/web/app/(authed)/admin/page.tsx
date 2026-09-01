import { Suspense } from 'react';
import { AttentionStrip } from '~/components/admin/attention-strip';
import { PanelBoundary } from '~/components/admin/panel-boundary';
import { PulseBand } from '~/components/admin/pulse-band';
import { cachedPulse, cachedRadar } from '~/lib/admin/cached';

/**
 * Overview — "Is Hale alive today, and does anything need me?" The Line stays
 * the hero; under it, four glance tiles that are DOORS to the tabs, not
 * charts. Everything else lives on its own tab now.
 */

async function BandBody() {
  const pulse = await cachedPulse();
  return <PulseBand pulse={pulse} />;
}

async function StripBody() {
  const [pulse, radar] = await Promise.all([cachedPulse(), cachedRadar()]);
  const freshest = radar.freshestVerifiedAt ? new Date(radar.freshestVerifiedAt) : null;
  const radarStaleDays = freshest
    ? Math.floor((Date.now() - freshest.getTime()) / 86_400_000)
    : null;
  return (
    <AttentionStrip
      failuresToday={pulse.failuresToday}
      spendTodayUsd={pulse.spendTodayUsd}
      newFamiliesToday={pulse.newFamiliesToday}
      radarStaleDays={radarStaleDays}
    />
  );
}

export default function AdminOverviewPage() {
  return (
    <main className="adm-stage">
      <PanelBoundary label="The line">
        <Suspense fallback={<div className="adm-band" style={{ minHeight: 180 }} />}>
          <BandBody />
        </Suspense>
      </PanelBoundary>
      <PanelBoundary label="Attention strip">
        <Suspense fallback={<div className="adm-skeleton animate-pulse" aria-hidden="true" />}>
          <StripBody />
        </Suspense>
      </PanelBoundary>
    </main>
  );
}
