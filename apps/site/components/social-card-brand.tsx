import { SITE_URL } from '~/lib/app-url';

export const SOCIAL_CARD_PALETTE = {
  navy: '#17294A',
  cream: '#F7F4EC',
  amber: '#B26B1F',
  softCream: 'rgba(247,244,236,0.74)',
} as const;

const SOCIAL_CARD_LOGO_URL = new URL('/icon.png', SITE_URL).toString();

interface SocialCardBrandProps {
  label?: string;
}

export function SocialCardBrand({ label = 'Hale' }: SocialCardBrandProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
      {/* next/image is not supported inside ImageResponse/Satori. This is the
          real Hale mark from the canonical site icon, rendered by the
          social-card pipeline from the absolute URL ImageResponse requires. */}
      <img
        src={SOCIAL_CARD_LOGO_URL}
        alt=""
        width={56}
        height={56}
        style={{ width: 56, height: 56, borderRadius: 17 }}
      />
      <div style={{ fontSize: 38, color: SOCIAL_CARD_PALETTE.cream, fontWeight: 600 }}>{label}</div>
    </div>
  );
}
