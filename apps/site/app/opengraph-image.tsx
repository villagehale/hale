import { ImageResponse } from 'next/og';

// Branded social-share card (og:image + twitter:image). Meadow palette:
// Prussian canvas, cream ink, apricot mark. This is what renders when the
// landing is shared into a parent group — the free-traction surface.
export const alt = 'Hale — the village every parent needs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: '#01204F',
          padding: 88,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 9999,
              backgroundColor: '#c8622d',
            }}
          />
          <div style={{ fontSize: 40, color: '#f6f1e7', fontWeight: 600 }}>
            Hale
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              fontSize: 76,
              color: '#f6f1e7',
              fontWeight: 700,
              letterSpacing: -1.5,
              lineHeight: 1.04,
            }}
          >
            The village every parent needs
          </div>
          <div style={{ fontSize: 32, color: 'rgba(246,241,231,0.74)' }}>
            Find what families near you actually do. Your data stays in Canada.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
