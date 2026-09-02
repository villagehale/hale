'use client';

/**
 * Horizontal labeled funnel — custom divs, not a funnel lib. Widths are
 * relative to the first stage; each later stage shows its conversion % from
 * the one before. The converted (last) stage is the page's ONE amber fill.
 */
export interface FunnelStage {
  label: string;
  count: number;
}

export function FunnelBars({ stages }: { stages: FunnelStage[] }) {
  const base = stages[0]?.count ?? 0;
  return (
    <div className="adm-funnel">
      {stages.map((stage, i) => {
        const prev = i === 0 ? null : (stages[i - 1]?.count ?? 0);
        const pct = prev ? Math.round((stage.count / prev) * 100) : null;
        const width = base > 0 ? Math.max(1.5, (stage.count / base) * 100) : 1.5;
        const isConverted = i === stages.length - 1;
        return (
          <div key={stage.label} className="adm-funnel-stage">
            <span>{stage.label}</span>
            <div className="adm-funnel-track">
              <div
                className={`adm-funnel-fill${isConverted ? ' adm-funnel-fill-amber' : ''}`}
                style={{ width: `${width}%` }}
              />
            </div>
            <span>
              <span className="adm-num">{stage.count}</span>
              {pct !== null ? <span className="adm-funnel-pct"> · {pct}%</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
