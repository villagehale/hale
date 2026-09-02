import type { PulseData } from '~/lib/admin/queries/pulse';
import { ADMIN_TIME_ZONE } from '~/lib/admin/window';
import { BigNumber } from './big-number';

/**
 * The signature — "The Line". The day's Georgia numeral sits INSIDE the
 * instrument: a 24-hour strip of amber ticks, one per hour of inbound texts,
 * on the navy band. Server-rendered SVG; only the numeral roll is a client
 * island.
 */
const TICKS = 24;
const TICK_W = 7;
const TICK_GAP = 3;
const STRIP_H = 44;

function TickStrip({ hourly }: { hourly: PulseData['hourly'] }) {
  const max = Math.max(1, ...hourly.map((h) => h.count));
  const width = TICKS * (TICK_W + TICK_GAP) - TICK_GAP;
  const total = hourly.reduce((sum, h) => sum + h.count, 0);
  return (
    <svg
      viewBox={`0 0 ${width} ${STRIP_H}`}
      width="100%"
      height={STRIP_H}
      role="img"
      aria-label={`${total} inbound texts over the last 24 hours`}
      preserveAspectRatio="none"
    >
      {hourly.map((hour, i) => {
        const h = hour.count === 0 ? 2 : Math.max(4, Math.round((hour.count / max) * STRIP_H));
        return (
          <rect
            key={hour.hourIso}
            x={i * (TICK_W + TICK_GAP)}
            y={STRIP_H - h}
            width={TICK_W}
            height={h}
            rx={2}
            fill="#b26b1f"
            opacity={hour.count === 0 ? 0.35 : 1}
          />
        );
      })}
    </svg>
  );
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
}

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ADMIN_TIME_ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function PulseBand({ pulse }: { pulse: PulseData }) {
  const asOfMinutes = minutesAgo(pulse.asOf);
  return (
    <header className="adm-band">
      <div className="adm-band-top">
        <span className="adm-wordmark">Hale / admin</span>
        <span className="adm-band-meta">
          {dateFormat.format(new Date())} · data as of{' '}
          {asOfMinutes === 0 ? 'now' : `${asOfMinutes}m ago`}
        </span>
      </div>
      <div className="adm-instrument">
        <div>
          <BigNumber value={pulse.familiesToday} />
          <div className="adm-hero-label">families texting today</div>
        </div>
        <div className="adm-ticks">
          <TickStrip hourly={pulse.hourly} />
          <div className="adm-hero-label">last 24h · one tick per hour of inbound texts</div>
        </div>
      </div>
      <div className="adm-ribbon">
        <span>
          in <strong>{pulse.msgsInToday}</strong>
        </span>
        <span>
          out <strong>{pulse.msgsOutToday}</strong>
        </span>
        <span>
          new families <strong>{pulse.newFamiliesToday}</strong>
        </span>
        <span className={pulse.failuresToday > 0 ? 'adm-ribbon-fail' : undefined}>
          failures <strong>{pulse.failuresToday}</strong>
        </span>
        <span>
          spend <strong>${pulse.spendTodayUsd.toFixed(2)}</strong>
        </span>
      </div>
    </header>
  );
}
