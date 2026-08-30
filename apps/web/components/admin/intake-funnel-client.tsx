'use client';

import type { IntakeDay } from '~/lib/admin/queries/intake-funnel';
import { lastDays } from '~/lib/admin/window';
import { FunnelBars } from './funnel-bars';
import { useWindowDays } from './window-dial';

/** Dial-sliced sums over the per-day intake rows → the three funnel stages. */
export function IntakeFunnelClient({
  days: rows,
  sources,
}: {
  days: IntakeDay[];
  sources: { code: string; count: number }[];
}) {
  const windowDays = useWindowDays();
  const inWindow = new Set(lastDays(windowDays));
  let started = 0;
  let engaged = 0;
  let provisioned = 0;
  let dropped = 0;
  for (const row of rows) {
    if (!inWindow.has(row.day)) continue;
    started += row.started;
    engaged += row.engaged;
    provisioned += row.provisioned;
    dropped += row.dropped;
  }

  if (started === 0) {
    return <p className="adm-state">No intake sessions in this window.</p>;
  }

  return (
    <div>
      <FunnelBars
        stages={[
          { label: 'started', count: started },
          { label: 'engaged', count: engaged },
          { label: 'family', count: provisioned },
        ]}
      />
      <p className="adm-state">
        dropped without a family: <span className="adm-num">{dropped}</span>
        {sources.length > 0
          ? ` · sources (365d): ${sources.map((s) => `${s.code} ${s.count}`).join(' · ')}`
          : null}
      </p>
    </div>
  );
}
