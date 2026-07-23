import { ImageResponse } from 'next/og';
import { SOCIAL_CARD_PALETTE, SocialCardBrand } from '~/components/social-card-brand';

// Branded social-share card (og:image + twitter:image). Current marketing palette:
// navy canvas, cream ink, amber rule, and the real Hale mark. This is what renders when the
// landing is shared into a parent group — the free-traction surface.
export const alt = 'Hale — the village every parent needs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: SOCIAL_CARD_PALETTE.navy,
        padding: 88,
        fontFamily: 'sans-serif',
      }}
    >
      <SocialCardBrand />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            width: 84,
            height: 8,
            borderRadius: 4,
            backgroundColor: SOCIAL_CARD_PALETTE.amber,
          }}
        />
        <div
          style={{
            fontSize: 76,
            color: SOCIAL_CARD_PALETTE.cream,
            fontWeight: 700,
            letterSpacing: -1.5,
            lineHeight: 1.04,
          }}
        >
          The village every parent needs
        </div>
        <div style={{ fontSize: 32, color: SOCIAL_CARD_PALETTE.softCream }}>
          Find what families near you actually do. Your data stays in Canada.
        </div>
      </div>
    </div>,
    { ...size },
  );
}
