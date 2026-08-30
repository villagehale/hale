'use client';

/**
 * The one tooltip every recharts chart shares: white card, navy ink, exact
 * value + date. Identity comes from the label text (the legend carries the
 * series mark), so the tooltip text itself stays in ink tokens.
 */
export function AdmChartTooltip({
  active,
  label,
  payload,
  format,
}: {
  active?: boolean;
  label?: string | number;
  payload?: { name?: string; value?: number | string }[];
  format?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="adm-tooltip">
      <div className="adm-tooltip-day">{label}</div>
      {payload.map((entry) => (
        <div key={entry.name}>
          {entry.name}:{' '}
          <span className="adm-num">
            {typeof entry.value === 'number' && format ? format(entry.value) : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}
