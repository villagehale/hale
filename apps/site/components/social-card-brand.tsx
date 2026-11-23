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
  /** Data URI when the card is rendered without fetching the live site. */
  logoSrc?: string;
  /** Wordmark ink. The light homepage paints the name in navy. */
  ink?: string;
}

export function SocialCardBrand({
  label = 'Hale',
  logoSrc = SOCIAL_CARD_LOGO_URL,
  ink = SOCIAL_CARD_PALETTE.navy,
}: SocialCardBrandProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      {/* next/image is not supported inside ImageResponse/Satori. This is the
          real Hale mark from the canonical site icon, at the header's 30% radius. */}
      <img
        src={logoSrc}
        alt=""
        width={56}
        height={56}
        style={{ width: 56, height: 56, borderRadius: 17 }}
      />
      <div
        style={{
          fontSize: 36,
          color: ink,
          fontWeight: 600,
          fontFamily: 'Figtree',
          letterSpacing: -0.4,
        }}
      >
        {label}
      </div>
    </div>
  );
}
