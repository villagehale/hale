import { ImageResponse } from 'next/og';
import { getAnswer } from '~/lib/answers/index';

// Per-question social-share card. Same Meadow palette as the root card
// (Prussian canvas, cream ink, apricot mark), with the question as the headline
// so a shared answer link reads as a specific, answered question.
export const alt = 'A parenting answer from Hale';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getAnswer(slug);
  const headline = page?.question ?? 'The village every parent needs';

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
          <div style={{ fontSize: 36, color: '#f6f1e7', fontWeight: 600 }}>Hale · Answers</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              fontSize: 60,
              color: '#f6f1e7',
              fontWeight: 700,
              letterSpacing: -1.5,
              lineHeight: 1.08,
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: 28, color: 'rgba(246,241,231,0.74)' }}>
            Cited, calm guidance — general, not medical advice.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
