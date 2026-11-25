import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import type { Locale } from '~/i18n/routing';
import {
  type PaintedShareCard,
  SHARE_CARD_SIZE,
  type ShareThreadLine,
} from '~/lib/site/share-cards';

/**
 * Style D, fitted to 1200×630: lined notes paper, the flat navy turtle, a
 * Caveat Brush headline with a yellow marker, and an iPhone Messages screen.
 * No shore photograph and no promo gradient. Avatar gradients are the ones
 * on the Style D phone.
 *
 * Fonts are static OFL instances. Read by path, not `new URL(..., import.meta.url)`:
 * webpack rewrites that into its own URL, and readFileSync fails the production
 * build while collecting /og. next.config traces these files into the function.
 */

const PAPER = '#FFF8DC';
const RULE = '#E6DCC0';
const INK = '#1C1C1E';
const NOTES = '#E0A500';
const MARKER = '#FFE066';
const FOOTER = '#8a7a50';
const IM_OUT = '#0A84FF';
const IM_IN = '#E9E9EB';
const IM_META = '#8E8E93';
const BEZEL = '#1b1b1d';

const LINE_TOPS = Array.from({ length: 16 }, (_, index) => 28 + index * 40);
const LEFT_WIDTH = 680;

function readSiteFile(...parts: string[]): Buffer {
  const candidates = [join(process.cwd(), ...parts), join(process.cwd(), 'apps', 'site', ...parts)];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`share card asset missing: ${parts.join('/')}`);
  return readFileSync(found);
}

const FIGTREE_400 = readSiteFile('assets', 'og-fonts', 'figtree-400.ttf');
const FIGTREE_600 = readSiteFile('assets', 'og-fonts', 'figtree-600.ttf');
const CAVEAT = readSiteFile('assets', 'og-fonts', 'caveat-brush-400.ttf');
const DM_MONO = readSiteFile('assets', 'og-fonts', 'dm-mono-400.ttf');
const MA_SHAN = readSiteFile('assets', 'og-fonts', 'ma-shan-zheng-400.ttf');

const LOGO = `data:image/png;base64,${readSiteFile('app', 'icon.png').toString('base64')}`;
const RAISE_HANDS = `data:image/png;base64,${readSiteFile('assets', 'og', 'raise-hands.png').toString('base64')}`;

function headlineSize(text: string, locale: Locale): number {
  const weight = locale === 'zh' ? text.length * 1.7 : text.length;
  if (weight > 78) return 44;
  if (weight > 56) return 52;
  if (weight > 36) return 62;
  return 72;
}

function sloganSize(locale: Locale): number {
  if (locale === 'fr') return 46;
  if (locale === 'zh') return 64;
  return 72;
}

function Slogan({ card }: { card: PaintedShareCard }) {
  const slogan = card.slogan;
  if (!slogan) return null;
  const size = sloganSize(card.locale);
  const line = {
    display: 'flex' as const,
    fontFamily: card.headlineFont,
    fontSize: size,
    lineHeight: 1.05,
    color: INK,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={line}>{slogan.lead}</div>
      {slogan.quote ? <div style={line}>{slogan.quote}</div> : null}
      {card.locale === 'fr' && slogan.bridge ? <div style={line}>{slogan.bridge}</div> : null}
      <div style={{ ...line, alignItems: 'flex-end' }}>
        {card.locale !== 'fr' && slogan.bridge ? (
          <div style={{ display: 'flex', marginRight: 12 }}>{slogan.bridge}</div>
        ) : null}
        <div style={{ display: 'flex', position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              left: -6,
              right: -6,
              bottom: Math.round(size * 0.12),
              height: Math.round(size * 0.42),
              backgroundColor: MARKER,
            }}
          />
          <div style={{ display: 'flex', position: 'relative' }}>{slogan.marked}</div>
        </div>
      </div>
    </div>
  );
}

function Avatar({
  label,
  background,
  logo,
  overlap,
}: {
  label?: string;
  background: string;
  logo?: boolean;
  overlap?: boolean;
}) {
  const gradient = background.startsWith('linear-gradient');
  return (
    <div
      style={{
        display: 'flex',
        width: 30,
        height: 30,
        borderRadius: 15,
        backgroundColor: gradient ? '#0c1a52' : background,
        ...(gradient ? { backgroundImage: background } : {}),
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontFamily: 'Figtree',
        fontSize: 14,
        fontWeight: 600,
        marginLeft: overlap ? -8 : 0,
        border: '2px solid #f6f6f6',
        overflow: 'hidden',
      }}
    >
      {logo ? <img src={LOGO} alt="" width={30} height={30} /> : label}
    </div>
  );
}

function bubbleFont(text: string): 'Figtree' | 'Ma Shan Zheng' {
  return /[\u3400-\u9fff]/.test(text) ? 'Ma Shan Zheng' : 'Figtree';
}

function BubbleCopy({ text, color }: { text: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', color }}>
      {text.split('\n').map((line) => (
        <div key={line} style={{ display: 'flex', fontFamily: bubbleFont(line) }}>
          {line}
        </div>
      ))}
    </div>
  );
}

function ThreadAvatar({ from }: { from: ShareThreadLine['from'] }) {
  if (from === 'hale') {
    return (
      <div
        style={{
          display: 'flex',
          width: 26,
          height: 26,
          borderRadius: 13,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <img src={LOGO} alt="" width={26} height={26} />
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        width: 26,
        height: 26,
        borderRadius: 13,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontFamily: 'Figtree',
        fontWeight: 600,
        fontSize: 12,
        backgroundImage: 'linear-gradient(180deg, #E88AB4 0%, #C4588B 100%)',
      }}
    >
      P
    </div>
  );
}

function Thread({ card }: { card: PaintedShareCard }) {
  const runs: Array<{ from: ShareThreadLine['from']; name: string; texts: string[] }> = [];
  for (const line of card.chat.lines) {
    const last = runs[runs.length - 1];
    if (last && last.from === line.from && line.from !== 'me') {
      last.texts.push(line.text);
    } else {
      runs.push({ from: line.from, name: line.name, texts: [line.text] });
    }
  }
  const incoming = runs.filter((run) => run.from !== 'me');
  const outgoing = runs.find((run) => run.from === 'me');
  const deliveredFont = /[\u3400-\u9fff]/.test(card.chat.delivered) ? 'Ma Shan Zheng' : 'Figtree';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        justifyContent: 'flex-end',
        gap: 8,
        padding: '8px 12px 2px 12px',
      }}
    >
      {incoming.map((run) => (
        <div key={run.from} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div
            style={{
              display: 'flex',
              marginLeft: 32,
              fontFamily: 'Figtree',
              fontSize: 12,
              lineHeight: 1,
              color: IM_META,
            }}
          >
            {run.name}
          </div>
          {run.texts.map((text) => (
            <div key={text} style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              {text === run.texts[run.texts.length - 1] ? (
                <ThreadAvatar from={run.from} />
              ) : (
                <div style={{ display: 'flex', width: 26, flexShrink: 0 }} />
              )}
              <div
                style={{
                  display: 'flex',
                  maxWidth: 286,
                  backgroundColor: IM_IN,
                  color: '#000000',
                  borderRadius: 16,
                  padding: '6px 10px',
                  fontFamily: 'Figtree',
                  fontSize: 18,
                  lineHeight: 1.15,
                }}
              >
                <BubbleCopy text={text} color="#000000" />
              </div>
            </div>
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 286,
              backgroundColor: IM_OUT,
              color: '#ffffff',
              borderRadius: 16,
              padding: '6px 10px',
              fontFamily: 'Figtree',
              fontSize: 18,
              lineHeight: 1.15,
            }}
          >
            <BubbleCopy text={outgoing?.texts[0] ?? ''} color="#ffffff" />
            <img src={RAISE_HANDS} alt="" width={20} height={20} />
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            fontFamily: deliveredFont,
            fontSize: 12,
            lineHeight: 1,
            color: IM_META,
          }}
        >
          {card.chat.delivered}
        </div>
      </div>
    </div>
  );
}

function Phone({ card }: { card: PaintedShareCard }) {
  const groupFont = /[\u3400-\u9fff]/.test(card.chat.group) ? 'Ma Shan Zheng' : 'Figtree';
  return (
    <div
      style={{
        position: 'absolute',
        right: 36,
        top: 72,
        width: 420,
        height: 530,
        display: 'flex',
        transform: 'rotate(-1.5deg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 420,
          height: 530,
          borderRadius: 48,
          padding: 9,
          backgroundColor: BEZEL,
          backgroundImage:
            'linear-gradient(160deg, #5a5a60 0%, #2c2c2f 28%, #1b1b1d 62%, #3a3a3e 100%)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            backgroundColor: '#ffffff',
            borderRadius: 40,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              height: 40,
              padding: '10px 22px 0 22px',
              fontFamily: 'Figtree',
              fontWeight: 600,
              fontSize: 15,
              color: '#000000',
            }}
          >
            <div style={{ display: 'flex' }}>9:41</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ width: 16, height: 10, borderRadius: 2, backgroundColor: '#000000' }} />
              <div style={{ width: 14, height: 10, borderRadius: 2, backgroundColor: '#000000' }} />
            </div>
          </div>
          <div
            style={{
              position: 'absolute',
              left: 176,
              top: 10,
              width: 78,
              height: 22,
              borderRadius: 12,
              backgroundColor: '#000000',
            }}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              backgroundColor: '#f6f6f6',
              borderBottom: '1px solid #e3e3e6',
              padding: '4px 0 8px 0',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 12,
                top: 18,
                color: IM_OUT,
                fontFamily: 'Figtree',
                fontSize: 28,
                lineHeight: 1,
              }}
            >
              ‹
            </div>
            <div style={{ display: 'flex', marginLeft: 8 }}>
              <Avatar label="J" background="linear-gradient(180deg, #7FA8F5 0%, #4D7CE0 100%)" />
              <Avatar
                label="P"
                background="linear-gradient(180deg, #E88AB4 0%, #C4588B 100%)"
                overlap
              />
              <Avatar background="#0c1a52" logo overlap />
            </div>
            <div
              style={{
                display: 'flex',
                marginTop: 4,
                fontFamily: groupFont,
                fontSize: 15,
                color: '#111111',
              }}
            >
              {`${card.chat.group} ›`}
            </div>
          </div>
          <Thread card={card} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px 16px 12px',
            }}
          >
            <div
              style={{
                display: 'flex',
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: IM_IN,
                color: IM_META,
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'Figtree',
                fontSize: 22,
              }}
            >
              +
            </div>
            <div
              style={{
                display: 'flex',
                flexGrow: 1,
                height: 32,
                borderRadius: 16,
                border: '1px solid #C7C7CC',
                alignItems: 'center',
                padding: '0 12px',
                color: '#C7C7CC',
                fontFamily: 'Figtree',
                fontSize: 16,
              }}
            >
              iMessage
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One 1200×630 Style D card. */
export function renderShareCard(card: PaintedShareCard): ImageResponse {
  const size = headlineSize(card.headline, card.locale);
  return new ImageResponse(
    <div
      style={{
        width: SHARE_CARD_SIZE.width,
        height: SHARE_CARD_SIZE.height,
        display: 'flex',
        position: 'relative',
        backgroundColor: PAPER,
        overflow: 'hidden',
      }}
    >
      {LINE_TOPS.map((top) => (
        <div
          key={top}
          style={{
            position: 'absolute',
            left: 0,
            top,
            width: SHARE_CARD_SIZE.width,
            height: 2,
            backgroundColor: RULE,
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 36,
          right: 36,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: 'Figtree',
          fontSize: 26,
          fontWeight: 600,
          color: NOTES,
        }}
      >
        <div style={{ display: 'flex' }}>‹ Notes</div>
        <div style={{ display: 'flex' }}>Done</div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: 40,
          top: 64,
          display: 'flex',
          flexDirection: 'column',
          width: LEFT_WIDTH,
        }}
      >
        <div style={{ display: 'flex', marginBottom: 12 }}>
          <img src={LOGO} alt="" width={68} height={68} style={{ borderRadius: 16 }} />
        </div>
        {card.slogan ? (
          <Slogan card={card} />
        ) : (
          <div
            style={{
              display: 'flex',
              width: LEFT_WIDTH - 8,
              fontFamily: card.headlineFont,
              fontSize: size,
              lineHeight: 1.08,
              color: INK,
            }}
          >
            {card.headline}
          </div>
        )}
        {card.flag ? (
          <div
            style={{
              display: 'flex',
              marginTop: 14,
              alignSelf: 'flex-start',
              backgroundColor: MARKER,
              color: INK,
              fontFamily: 'Figtree',
              fontWeight: 600,
              fontSize: 22,
              lineHeight: 1,
              padding: '8px 12px',
            }}
          >
            {card.flag}
          </div>
        ) : null}
        {card.prices ? (
          <div
            style={{
              display: 'flex',
              marginTop: 8,
              fontFamily: 'Figtree',
              fontWeight: 600,
              fontSize: 26,
              color: INK,
            }}
          >
            {card.prices}
          </div>
        ) : null}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 40,
          bottom: 18,
          display: 'flex',
          width: LEFT_WIDTH,
          fontSize: 18,
          color: FOOTER,
          letterSpacing: 0.4,
        }}
      >
        {card.footer.map((part) => (
          <div
            key={part.font}
            style={{ display: 'flex', fontFamily: part.font, fontSize: 18, color: FOOTER }}
          >
            {part.text}
          </div>
        ))}
      </div>
      <Phone card={card} />
    </div>,
    {
      ...SHARE_CARD_SIZE,
      fonts: [
        { name: 'Figtree', data: FIGTREE_400, weight: 400, style: 'normal' },
        { name: 'Figtree', data: FIGTREE_600, weight: 600, style: 'normal' },
        { name: 'Caveat Brush', data: CAVEAT, weight: 400, style: 'normal' },
        { name: 'DM Mono', data: DM_MONO, weight: 400, style: 'normal' },
        { name: 'Ma Shan Zheng', data: MA_SHAN, weight: 400, style: 'normal' },
      ],
    },
  );
}
