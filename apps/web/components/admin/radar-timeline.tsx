import type { RadarData } from '~/lib/admin/queries/radar';
import { ADMIN_TIME_ZONE } from '~/lib/admin/window';

/**
 * The opening timeline: upcoming registration windows as dots on one
 * horizontal date axis — a schedule is a timeline, not a table-first. A solid
 * dot marks the general open, a hollow one the resident-priority open; the
 * `opens in Nd` chip goes amber-wash inside a week. Hover (title) reveals the
 * exact Toronto dates. Server-rendered; no state, no motion.
 */
export type UpcomingWindow = RadarData['upcoming'][number];

const SOON_DAYS = 7;

/** Pure: whole days until an instant, floored at 0 (already-open clamps). */
export function opensInDays(openAt: string, nowIso: string): number {
  const ms = new Date(openAt).getTime() - new Date(nowIso).getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Pure: 0–100% position of an instant on the now→horizon axis. */
export function timelinePercent(at: string, nowIso: string, horizonIso: string): number {
  const now = new Date(nowIso).getTime();
  const horizon = new Date(horizonIso).getTime();
  if (horizon <= now) return 0;
  const pct = ((new Date(at).getTime() - now) / (horizon - now)) * 100;
  return Math.min(100, Math.max(0, pct));
}

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ADMIN_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function RadarTimeline({
  windows,
  nowIso = new Date().toISOString(),
}: {
  windows: UpcomingWindow[];
  nowIso?: string;
}) {
  if (windows.length === 0) {
    return <p className="adm-state">No upcoming registration windows on file.</p>;
  }
  const horizon = windows.reduce(
    (max, w) => (w.openAt > max ? w.openAt : max),
    windows[0]?.openAt ?? nowIso,
  );
  return (
    <div className="adm-timeline">
      {windows.map((w) => {
        const inDays = opensInDays(w.openAt, nowIso);
        const openTitle = `opens ${dateFormat.format(new Date(w.openAt))}${
          w.residentOpenAt ? ` · residents ${dateFormat.format(new Date(w.residentOpenAt))}` : ''
        }`;
        return (
          <div
            key={`${w.municipality}-${w.programDomain}-${w.cycleLabel}`}
            className="adm-timeline-row"
          >
            <span className="adm-timeline-label">
              {w.municipality} · {w.programDomain.replace(/_/g, ' ')} · {w.cycleLabel}
            </span>
            <span className="adm-timeline-track" title={openTitle}>
              {w.residentOpenAt ? (
                <span
                  className="adm-timeline-dot adm-timeline-dot-resident"
                  style={{ left: `${timelinePercent(w.residentOpenAt, nowIso, horizon)}%` }}
                />
              ) : null}
              <span
                className="adm-timeline-dot"
                style={{ left: `${timelinePercent(w.openAt, nowIso, horizon)}%` }}
              />
            </span>
            <span className={`adm-timeline-chip${inDays < SOON_DAYS ? ' adm-stale' : ''}`}>
              opens in {inDays}d
            </span>
          </div>
        );
      })}
    </div>
  );
}
