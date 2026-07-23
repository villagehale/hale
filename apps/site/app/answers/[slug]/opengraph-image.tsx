import { ImageResponse } from 'next/og';
import { SOCIAL_CARD_PALETTE, SocialCardBrand } from '~/components/social-card-brand';
import { getAnswer } from '~/lib/answers/index';

// Per-question social-share card. Same Meadow palette as the root card
// (Prussian canvas, cream ink, apricot mark), with the question as the headline
// so a shared answer link reads as a specific, answered question.
export const alt = 'A parenting guide from Hale';
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
      <SocialCardBrand label="Hale · Parenting guides" />
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
            fontSize: 60,
            color: SOCIAL_CARD_PALETTE.cream,
            fontWeight: 700,
            letterSpacing: -1.5,
            lineHeight: 1.08,
          }}
        >
          {headline}
        </div>
        <div style={{ fontSize: 28, color: SOCIAL_CARD_PALETTE.softCream }}>
          Cited, calm guidance — general, not medical advice.
        </div>
      </div>
    </div>,
    { ...size },
  );
}
