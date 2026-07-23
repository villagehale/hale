import { ImageResponse } from 'next/og';
import { SOCIAL_CARD_PALETTE, SocialCardBrand } from '~/components/social-card-brand';
import { getCheckpoint } from '~/lib/milestones/index';

// Per-age social-share card. Same marketing palette and real Hale mark as the
// root and parenting-guide cards, with the age as the headline so a shared
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
      <SocialCardBrand label="Hale · Milestones" />
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
            fontSize: 64,
            color: SOCIAL_CARD_PALETTE.cream,
            fontWeight: 700,
            letterSpacing: -1.5,
            lineHeight: 1.08,
          }}
        >
          {headline}
        </div>
        <div style={{ fontSize: 28, color: SOCIAL_CARD_PALETTE.softCream }}>
          A picture of typical, from the CDC — general guidance, not a test.
        </div>
      </div>
    </div>,
    { ...size },
  );
}
