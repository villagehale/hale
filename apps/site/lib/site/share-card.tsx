import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { SocialCardBrand } from '~/components/social-card-brand';
import { SHARE_CARD_SIZE, type ShareCardSpec } from '~/lib/site/share-cards';

/**
 * Tokens copied from the light homepage hero (.rd in redesign.css):
 * page #fdfcfa, type #17294a, accent #b26b1f, lede #5c6b87, meta #647290.
 * The shore photograph is the same hale-shore-hero.webp, covered at
 * object-position center 32%, under the live scrim and type veil.
 * Headlines on the page are Helvetica Neue, which we cannot ship. Figtree is
 * the self-hosted UI face (eyebrow, wordmark, chat). Source Serif 4 is the body.
 */

const PAGE = '#fdfcfa';
const NAVY = '#17294a';
const AMBER = '#b26b1f';
const SLATE = '#5c6b87';
const META = '#647290';
const IM_OUT = '#0088ff';
const IM_IN = '#e9e9eb';
const IM_META = '#6e6e73';

// Satori cannot read the site's variable woff2 masters. These are static
// instances of the same OFL files (Figtree 400/500/600, Source Serif 4 400).
// Read by path, not `new URL(..., import.meta.url)`: webpack rewrites that
// into its own URL, and readFileSync on it fails the production build while
// collecting /og/[card]. next.config traces these files into the function.

function readSiteFile(...parts: string[]): Buffer {
  const candidates = [join(process.cwd(), ...parts), join(process.cwd(), 'apps', 'site', ...parts)];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`share card asset missing: ${parts.join('/')}`);
  return readFileSync(found);
}

const FIGTREE_400 = readSiteFile('assets', 'og-fonts', 'figtree-400.ttf');
const FIGTREE_500 = readSiteFile('assets', 'og-fonts', 'figtree-500.ttf');
const FIGTREE_600 = readSiteFile('assets', 'og-fonts', 'figtree-600.ttf');
const SOURCE_SERIF = readSiteFile('assets', 'og-fonts', 'source-serif-4-400.ttf');

const LOGO = `data:image/png;base64,${readSiteFile('app', 'icon.png').toString('base64')}`;

/**
 * hale-shore-hero.webp, cover-cropped to 1200×630 at object-position center 32%,
 * the same placement as .shore-art on the homepage. PNG because the OG renderer
 * does not decode webp. File: assets/hale-shore-og.png.
 */
const SHORE = `data:image/png;base64,${readSiteFile('assets', 'hale-shore-og.png').toString('base64')}`;

const CHAT = {
  parent: 'anything for the kids saturday?',
  hale: ['Swim at 10 fits all three. Priya’s mom can drive.', 'Want me to grab spots?'],
} as const;

function headlineSize(text: string, chat: boolean): number {
  if (text.length > 90) return 40;
  if (text.length > 60) return 48;
  if (chat) return 58;
  if (text.length > 42) return 56;
  return 72;
}

function Bubble({ text, tone }: { text: string; tone: 'in' | 'out' }) {
  const incoming = tone === 'in';
  return (
    <div style={{ display: 'flex', justifyContent: incoming ? 'flex-start' : 'flex-end' }}>
      <div
        style={{
          display: 'flex',
          maxWidth: 300,
          backgroundColor: incoming ? IM_IN : IM_OUT,
          color: incoming ? '#000000' : '#ffffff',
          borderRadius: 18,
          padding: '10px 14px',
          fontSize: 18,
          lineHeight: 1.29,
          fontFamily: 'Figtree',
          fontWeight: 400,
          letterSpacing: -0.15,
        }}
      >
        {text}
      </div>
    </div>
  );
}

/** The homepage Messages crop: white panel, grey received, #0088ff sent. */
function ChatMock() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 360,
        gap: 10,
        justifyContent: 'center',
        backgroundColor: '#ffffff',
        borderRadius: 18,
        padding: '22px 18px',
        border: '1px solid rgba(23, 41, 74, 0.10)',
        fontFamily: 'Figtree',
      }}
    >
      <Bubble text={CHAT.parent} tone="out" />
      <div
        style={{
          display: 'flex',
          marginTop: 6,
          fontSize: 13,
          lineHeight: 1.25,
          color: IM_META,
          fontFamily: 'Figtree',
        }}
      >
        Hale
      </div>
      {CHAT.hale.map((line) => (
        <Bubble key={line} text={line} tone="in" />
      ))}
    </div>
  );
}

/** One 1200×630 card that reads as a slice of the light homepage. */
export function shareCardImage(spec: ShareCardSpec): ImageResponse {
  const chat = spec.chat === true;
  const shore = SHORE;
  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: PAGE,
        padding: '56px 64px',
        fontFamily: 'Figtree',
        position: 'relative',
      }}
    >
      <img
        src={shore}
        alt=""
        width={SHARE_CARD_SIZE.width}
        height={SHARE_CARD_SIZE.height}
        style={{ position: 'absolute', top: 0, left: 0 }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: SHARE_CARD_SIZE.width,
          height: SHARE_CARD_SIZE.height,
          backgroundImage:
            'radial-gradient(78% 68% at 50% 46%, rgba(253,252,250,0.72) 0%, rgba(253,252,250,0.55) 46%, rgba(253,252,250,0.2) 100%), linear-gradient(180deg, rgba(253,252,250,0.45) 0%, rgba(253,252,250,0.15) 28%, rgba(253,252,250,0.35) 70%, rgba(253,252,250,0.92) 100%)',
        }}
      />
      <div style={{ display: 'flex', position: 'relative' }}>
        <SocialCardBrand logoSrc={LOGO} ink={NAVY} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 36,
          flexGrow: 1,
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, gap: 16 }}>
          {spec.eyebrow ? (
            <div
              style={{
                display: 'flex',
                fontSize: 18,
                fontWeight: 600,
                letterSpacing: 4,
                color: 'rgba(23, 41, 74, 0.72)',
                fontFamily: 'Figtree',
              }}
            >
              {spec.eyebrow}
            </div>
          ) : null}
          <div
            style={{
              width: 72,
              height: 6,
              borderRadius: 4,
              backgroundColor: AMBER,
            }}
          />
          <div
            style={{
              display: 'flex',
              fontSize: headlineSize(spec.headline, chat),
              color: NAVY,
              fontWeight: 500,
              letterSpacing: -1.6,
              lineHeight: 1.02,
              fontFamily: 'Figtree',
            }}
          >
            {spec.headline}
          </div>
          {spec.subline ? (
            <div
              style={{
                display: 'flex',
                fontSize: 28,
                lineHeight: 1.35,
                color: SLATE,
                fontFamily: 'Source Serif 4',
                fontWeight: 400,
              }}
            >
              {spec.subline}
            </div>
          ) : null}
        </div>
        {chat ? <ChatMock /> : null}
      </div>
      <div
        style={{
          display: 'flex',
          position: 'relative',
          fontSize: 20,
          color: META,
          fontFamily: 'Figtree',
          fontWeight: 500,
        }}
      >
        villagehale.com
      </div>
    </div>,
    {
      ...SHARE_CARD_SIZE,
      fonts: [
        { name: 'Figtree', data: FIGTREE_400, weight: 400, style: 'normal' },
        { name: 'Figtree', data: FIGTREE_500, weight: 500, style: 'normal' },
        { name: 'Figtree', data: FIGTREE_600, weight: 600, style: 'normal' },
        { name: 'Source Serif 4', data: SOURCE_SERIF, weight: 400, style: 'normal' },
      ],
    },
  );
}
