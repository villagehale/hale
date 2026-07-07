import { ImageResponse } from 'next/og';
import { getCheckpoint } from '~/lib/milestones/index';

// Per-age social-share card. Same Meadow palette as the answers OG (Prussian
// canvas, cream ink, apricot mark), with the age as the headline so a shared
// link reads as a specific age guide.
export const alt = "What's typical at your child's age, from Hale";
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ age: string }>;
}) {
  const { age } = await params;
  const checkpoint = getCheckpoint(age);
  const headline = checkpoint
    ? `What’s typical around ${checkpoint.ageLabel}`
    : 'Child development milestones by age';

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
          <div style={{ fontSize: 36, color: '#f6f1e7', fontWeight: 600 }}>Village Hale · Milestones</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              fontSize: 64,
              color: '#f6f1e7',
              fontWeight: 700,
              letterSpacing: -1.5,
              lineHeight: 1.08,
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: 28, color: 'rgba(246,241,231,0.74)' }}>
            A picture of typical, from the CDC — general guidance, not a test.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
