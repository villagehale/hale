'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { STALE_VERIFY_DAYS } from '~/lib/admin/panel-state';
import { tabHref } from './admin-tabs';

/**
 * The Overview glance tiles — four doors, not four charts. Each names today's
 * number and navigates to the tab that answers the follow-up question,
 * carrying the dial's `?w=` along. Zeros render honestly; nothing hides.
 */
export interface AttentionStripProps {
  failuresToday: number;
  spendTodayUsd: number;
  newFamiliesToday: number;
  /** Days since the radar's freshest verify, or null = never verified. */
  radarStaleDays: number | null;
}

function Tile({
  href,
  w,
  value,
  label,
  fail,
}: {
  href: string;
  w: string | null;
  value: React.ReactNode;
  label: string;
  fail?: boolean;
}) {
  return (
    <Link href={tabHref(href, w) as Route} className="adm-tile">
      <span className={`adm-stat-v${fail ? ' adm-tile-fail' : ''}`}>{value}</span>
      <span className="adm-stat-k">{label}</span>
    </Link>
  );
}

export function AttentionStrip(props: AttentionStripProps) {
  const w = useSearchParams().get('w');
  const stale = props.radarStaleDays !== null && props.radarStaleDays > STALE_VERIFY_DAYS;
  return (
    <div className="adm-tiles">
      <Tile
        href="/admin/operations"
        w={w}
        value={props.failuresToday}
        label="failures today"
        fail={props.failuresToday > 0}
      />
      <Tile
        href="/admin/agents"
        w={w}
        value={`$${props.spendTodayUsd.toFixed(2)}`}
        label="spend today"
      />
      <Tile
        href="/admin/engagement"
        w={w}
        value={props.newFamiliesToday}
        label="new families today"
      />
      <Tile
        href="/admin/radar"
        w={w}
        value={
          props.radarStaleDays === null ? (
            'never'
          ) : stale ? (
            <span className="adm-stale">{props.radarStaleDays}d ago</span>
          ) : (
            `${props.radarStaleDays}d ago`
          )
        }
        label={props.radarStaleDays === null ? 'radar never verified' : 'radar verified'}
      />
    </div>
  );
}
