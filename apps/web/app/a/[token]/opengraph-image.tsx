import { ImageResponse } from 'next/og';
import { villageKindLabel } from '~/lib/format/labels';
import { db } from '~/lib/db';
import { loadSharedActivity } from '~/lib/village/public-activity';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'a local pick · Hale';

const PRUSSIAN = '#003153';
const LINEN = '#faf7f1';
const APRICOT = '#f97316';

/** OG headlines truncate the (already-capped) public title to a card-safe length. */
const OG_TITLE_MAX = 90;

/**
 * Public share card (rule #1). Loads the SAME privacy-safe `loadSharedActivity`
 * as the page — only the public allow-list (title/kind) + coarse area. A
 * child-attributed candidate resolves null upstream (fail closed), so this card
 * can never surface teen/child content. An unknown token (or no DB) yields a
 * generic branded card.
 */
async function loadSafe(
  token: string,
): Promise<{ title: string; kind: string; area: string | null; count: number } | null> {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  const card = await loadSharedActivity(token, db());
  if (!card) {
    return null;
  }
  return {
    title: card.activity.title,
    kind: card.activity.kind,
    area: card.areaCoarse,
    count: card.activity.endorsementCount,
  };
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

  const headline = data ? data.title.slice(0, OG_TITLE_MAX) : 'a genuinely good local thing for families';
  const kindLabel = data ? villageKindLabel(data.kind) : null;
  const lovedBy = data && data.count >= 2 ? `loved by ${data.count} families · ` : '';
  const place = data?.area ? `${data.area} · ` : '';
  const subline = `${lovedBy}${place}villagehale.com`;

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
        {kindLabel ? (
          <span style={{ color: APRICOT, fontSize: 30, fontWeight: 600, marginBottom: 16 }}>
            {kindLabel}
          </span>
        ) : null}
        <span style={{ color: LINEN, fontSize: 68, fontWeight: 700, lineHeight: 1.05 }}>
          {headline}
        </span>
        <span style={{ color: APRICOT, fontSize: 34, fontWeight: 600, marginTop: 28 }}>
          {subline}
        </span>
      </div>
    </div>,
    size,
  );
}
