'use client';

import type { IntakeDay } from '~/lib/admin/queries/intake-funnel';
import { lastDays } from '~/lib/admin/window';
import { FunnelBars } from './funnel-bars';
import { useWindowDays } from './window-dial';

/** Dial-sliced sums over the per-day intake rows → the three funnel stages.
 * The venue-code sources render as their own table now, not a prose suffix. */
export function IntakeFunnelClient({ days: rows }: { days: IntakeDay[] }) {
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
      </p>
    </div>
  );
}
