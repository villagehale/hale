import { ImageResponse } from 'next/og';
import { db } from '~/lib/db';
import { loadSharedPicks } from '~/lib/village/public-picks';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = "a family's village picks · Hale";

const PRUSSIAN = '#003153';
const LINEN = '#faf7f1';
const APRICOT = '#f97316';

/**
 * Public share card (rule #1). Loads the SAME privacy-safe `loadSharedPicks` as
 * the page — only coarse area + the count of endorsed family-wide activities. An
 * unknown token (or no DB) yields a generic branded card so a bad link never
 * leaks data and never errors the crawler.
 */
async function loadSafe(token: string): Promise<{ count: number; area: string | null } | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  const picks = await loadSharedPicks(token, db());
  if (!picks) {
    return null;
  }
  return { count: picks.activities.length, area: picks.areaCoarse };
}

/** White sea-turtle silhouette — same brand mark as the /w OG card. */
function Turtle() {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative brand mark on an OG card.
    <svg width="180" height="124" viewBox="0 0 152 104" fill={LINEN}>
      <path d="M32 74 Q32 34 70 34 Q108 34 108 74 Z" />
      <rect x="32" y="64" width="76" height="13" rx="6.5" />
      <rect x="22" y="68" width="15" height="12" rx="6" />
      <rect x="38" y="72" width="23" height="15" rx="7.5" />
      <rect x="78" y="72" width="25" height="15" rx="7.5" />
      <rect x="104" y="48" width="22" height="15" rx="7.5" />
      <circle cx="126" cy="50" r="13" />
    </svg>
  );
}

export default async function OgImage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await loadSafe(token);

  const headline = data
    ? `${data.count} ${data.count === 1 ? 'pick' : 'picks'} families near you love`
    : 'the picks families near you actually love';
  const subline = data?.area ? `around ${data.area} · villagehale.com` : 'villagehale.com';

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: PRUSSIAN,
        padding: '72px 80px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Turtle />
        <span style={{ color: LINEN, fontSize: 40, fontWeight: 700, letterSpacing: '0.04em' }}>
          Hale
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ color: LINEN, fontSize: 72, fontWeight: 700, lineHeight: 1.05 }}>
          {headline}
        </span>
        <span style={{ color: APRICOT, fontSize: 36, fontWeight: 600, marginTop: 28 }}>
          {subline}
        </span>
      </div>
    </div>,
    size,
  );
}
