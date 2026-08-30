'use client';

import type { AuditDayAction } from '~/lib/admin/queries/audit-mix';
import { lastDays } from '~/lib/admin/window';
import { useWindowDays } from './window-dial';

const TOP_N = 12;

/** Horizontal bar list of audit action counts, dial-sliced client-side. */
export function AuditMixClient({ rows }: { rows: AuditDayAction[] }) {
  const windowDays = useWindowDays();
  const inWindow = new Set(lastDays(windowDays));
  const byAction = new Map<string, number>();
  for (const row of rows) {
    if (!inWindow.has(row.day)) continue;
    byAction.set(row.action, (byAction.get(row.action) ?? 0) + row.count);
  }
  const ranked = [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);

  if (ranked.length === 0) {
    return <p className="adm-state">No audit rows in this window.</p>;
  }
  const max = ranked[0]?.[1] ?? 1;
  return (
    <div className="adm-barlist">
      {ranked.map(([action, count]) => (
        <div key={action} className="adm-barlist-row">
          <span className="adm-barlist-label" title={action}>
            {action}
          </span>
          <div className="adm-barlist-track">
            <div className="adm-barlist-fill" style={{ width: `${(count / max) * 100}%` }} />
          </div>
          <span className="adm-num">{count}</span>
        </div>
      ))}
    </div>
  );
}
