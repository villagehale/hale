import { type ReactNode, createElement } from 'react';
import { STAMP_ICONS } from '~/lib/passport/icons';

type Shape = 'circle' | 'rect' | 'oct' | 'oval' | 'shield';

type Profile = {
  shape: Shape;
  ink: string;
  nameSize: number;
  tracking: number;
  nameY: number;
  dateY: number;
  dateSize: number;
};

/** Gallery table. One shape and one of the six inks per activity. */
const NAVY = '#1B2160';
const SEA = '#2E6DA4';
const TEAL = '#0F766E';
const RUST = '#9A3B26';
const PLUM = '#5B3A7A';
const GREEN = '#3F6B3A';

const ICON_AT: Record<Shape, string> = {
  circle: 'translate(45 46) scale(1.25)',
  rect: 'translate(46 26) scale(1.17)',
  oct: 'translate(46.5 27.5) scale(1.125)',
  oval: 'translate(46.5 28.5) scale(1.125)',
  shield: 'translate(46.5 27.5) scale(1.125)',
};

export const STAMP_PROFILES: Record<string, Profile> = {
  soccer: profile('circle', NAVY),
  swimming: profile('rect', SEA, 11, 0.35),
  skating: profile('oct', TEAL),
  zoo: profile('oval', RUST),
  karate: profile('shield', PLUM),
  aquarium: profile('circle', GREEN, 10.5, 0.25),
  ballet: profile('rect', NAVY),
  farm: profile('oct', SEA),
  hockey: profile('oval', TEAL),
  basketball: profile('shield', RUST, 10, 0.1),
  taekwondo: profile('circle', PLUM, 10, 0.15),
  dance: profile('rect', GREEN),
  'figure-skating': profile('oct', NAVY, 10, 0.1),
  golf: profile('oval', SEA),
  mma: profile('shield', TEAL),
  gymnastics: profile('circle', RUST, 10, 0.15),
  baseball: profile('rect', PLUM, 12, 0.4),
  skiing: profile('oct', GREEN),
  museum: profile('oval', NAVY),
  'christmas-market': profile('shield', SEA, 9, 0.05),
};

/** One or two strokes. The full icon turns into a blob at 26px. */
const MINI_GLYPHS: Record<string, string> = {
  soccer: `<circle cx="12" cy="12" r="6.5"/>`,
  swimming: `<path d="M2 9c2.2 2 4.2 2 6.4 0s4.2-2 6.4 0 4.2 2 6.4 0M2 15c2.2 2 4.2 2 6.4 0s4.2-2 6.4 0 4.2 2 6.4 0"/>`,
  skating: `<path d="M8 3h6l2 11H6zM4 20h16"/>`,
  zoo: `<circle cx="12" cy="13" r="6"/><path d="M9 12h.1M15 12h.1M10 16c1.2.8 2.8.8 4 0"/>`,
  karate: `<path d="M7 3h10l2 18H5zM7 12h10"/>`,
  aquarium: `<path d="M3 12c4-5 10-5 16 0-6 5-12 5-16 0z"/>`,
  ballet: `<path d="M7 6c1 7 .5 10-.5 13M17 6c-1 7-.5 10 .5 13"/>`,
  farm: `<path d="M3 12 L12 4 L21 12 V21 H3 Z"/>`,
  hockey: `<path d="M15 2 L8 17 H3M14 19h7"/>`,
  basketball: `<circle cx="12" cy="12" r="7"/><path d="M12 5v14M5 12h14"/>`,
  taekwondo: `<path d="M8 3v8l-4 9M8 8l12-3"/>`,
  dance: `<circle cx="13" cy="4" r="2"/><path d="M13 7l-1 7 4 6M12 14l-5 3"/>`,
  'figure-skating': `<circle cx="12" cy="4" r="2"/><path d="M12 7l1 8M8 20h8"/>`,
  golf: `<path d="M8 21V4l8 4-8 4M14 17h5"/>`,
  mma: `<path d="M7 8V5h9v5a4 4 0 01-4 4H9a2 2 0 01-2-2z"/>`,
  gymnastics: `<circle cx="12" cy="4" r="2"/><path d="M12 7v7M6 8l6 2 6-2M8 21l4-7 4 7"/>`,
  baseball: `<circle cx="12" cy="12" r="7"/>`,
  skiing: `<path d="M4 16 L20 8M6 20 L18 6"/>`,
  museum: `<path d="M3 10l9-6 9 6M6 10v9M12 10v9M18 10v9M4 19h16"/>`,
  'christmas-market': `<path d="M12 3l3 5h-2l3 5h-2l3 6H7l3-6H8l3-5H9z"/>`,
};

const LITES: Record<string, string> = {
  [NAVY]: '#C5CAF5',
  [SEA]: '#B9D7F2',
  [TEAL]: '#B7E6E0',
  [RUST]: '#F3C7BC',
  [PLUM]: '#E0D0F0',
  [GREEN]: '#C9E4C4',
};

function profile(shape: Shape, ink: string, nameSize = 13, tracking = 1): Profile {
  const nameY = shape === 'rect' ? 68 : shape === 'circle' ? 0 : 67;
  const dateY = shape === 'rect' ? 90 : shape === 'circle' ? 88 : shape === 'oval' ? 84 : 82;
  const dateSize = shape === 'circle' || shape === 'rect' ? 10.5 : 10;
  return { shape, ink, nameSize, tracking, nameY, dateY, dateSize };
}

function hash(id: string): number {
  let h = 0;
  for (const char of id) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
}

/** Gallery rotation: seeded by the stamp id, from −8° through +7°. */
export function stampTilt(id: string): number {
  return (hash(id) % 16) - 8;
}

export function StampMark({
  id,
  icon,
  kind,
  inferred,
  top,
  bottom,
  slot,
  mini = false,
}: {
  id: string;
  icon: string;
  kind: 'activity' | 'outing';
  inferred: boolean;
  top: string;
  bottom: string;
  slot: string;
  mini?: boolean;
}) {
  const known = STAMP_PROFILES[icon];
  const ink = known?.ink ?? NAVY;
  const shape = known?.shape ?? (kind === 'outing' ? 'oval' : 'circle');
  const tilt = stampTilt(id);
  const arc = shape === 'circle' && top.length <= 10;
  const nameSize = known?.nameSize ?? (top.length > 8 ? 10 : 13);
  const tracking = known?.tracking ?? (top.length > 8 ? 0.15 : 1);
  const nameY = known?.nameY ?? 68;
  const dateY = known?.dateY ?? 86;
  const dateSize = known?.dateSize ?? 10;
  const iconTransform = ICON_AT[shape];
  const size = mini ? 26 : kind === 'outing' ? 96 : 112;
  const safe = `${slot}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '');
  const paths = STAMP_ICONS[icon] ?? '';
  return (
    <svg
      className={inferred ? 'pp-stamp is-inferred' : 'pp-stamp'}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label={`${top} ${bottom}`}
      data-shape={shape}
      data-icon={icon}
      style={{
        transform: `rotate(${tilt}deg)`,
        ['--stamp-ink' as string]: ink,
        ['--stamp-ink-lite' as string]: LITES[ink] ?? '#E4E9F7',
      }}
    >
      <title>{`${top} ${bottom}`}</title>
      <defs>
        <filter id={`wear-${safe}`} x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="1.4"
            numOctaves="2"
            seed={hash(id) % 40}
            result="n"
          />
          <feColorMatrix
            in="n"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.7 1.12"
            result="m"
          />
          <feComposite in="SourceGraphic" in2="m" operator="in" />
        </filter>
      </defs>
      <g filter={mini ? undefined : `url(#wear-${safe})`}>
        <Edges shape={shape} inferred={inferred} heavy={mini} />
        {paths ? (
          <g
            className={mini ? 'pp-mini-icon' : undefined}
            transform={iconTransform}
            fill="none"
            stroke={mini ? '#fff' : 'currentColor'}
            strokeWidth={mini ? 3.2 : 1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <IconShapes markup={mini ? (MINI_GLYPHS[icon] ?? paths) : paths} />
          </g>
        ) : null}
        {mini ? null : arc ? (
          <>
            <path id={`arc-${safe}`} d="M 26 60 a 34 34 0 1 1 68 0" fill="none" />
            <text
              fontSize={nameSize}
              letterSpacing={tracking}
              fontWeight="800"
              fill="currentColor"
              className="pp-stamp-top"
            >
              <textPath href={`#arc-${safe}`} startOffset="50%" textAnchor="middle">
                {`· ${top} ·`}
              </textPath>
            </text>
          </>
        ) : (
          <text
            x="60"
            y={nameY}
            textAnchor="middle"
            fontSize={nameSize}
            letterSpacing={tracking}
            fontWeight="800"
            fill="currentColor"
            className="pp-stamp-top"
          >
            {top}
          </text>
        )}
        {mini ? null : (
          <text
            x="60"
            y={dateY}
            textAnchor="middle"
            fontSize={dateSize}
            fontWeight="700"
            fill="currentColor"
            className="pp-stamp-bottom"
          >
            {bottom}
          </text>
        )}
      </g>
    </svg>
  );
}

function FilledShape({ shape }: { shape: Shape }) {
  const fill = {
    fill: 'currentColor' as const,
    stroke: 'none' as const,
    className: 'pp-stamp-edge',
  };
  if (shape === 'rect') return <rect x="8" y="16" width="104" height="88" rx="8" {...fill} />;
  if (shape === 'oct') {
    return <polygon points="108,80 80,108 40,108 12,80 12,40 40,12 80,12 108,40" {...fill} />;
  }
  if (shape === 'oval') return <ellipse cx="60" cy="60" rx="52" ry="44" {...fill} />;
  if (shape === 'shield')
    return <path d="M60 8 L108 22 L104 74 Q60 112 16 74 L12 22 Z" {...fill} />;
  return <circle cx="60" cy="60" r="52" {...fill} />;
}

function Edges({
  shape,
  inferred,
  heavy = false,
}: {
  shape: Shape;
  inferred: boolean;
  heavy?: boolean;
}) {
  if (heavy) return <FilledShape shape={shape} />;
  const dash = inferred ? '5 4' : undefined;
  const outer = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: heavy ? 8 : 3,
    strokeDasharray: dash,
    className: 'pp-stamp-edge',
  };
  const inner = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: heavy ? 3.2 : 1.2,
    strokeDasharray: dash,
  };
  if (shape === 'rect') {
    return (
      <>
        <rect x="4" y="12" width="112" height="96" rx="6" {...outer} />
        <rect x="11" y="19" width="98" height="82" rx="3" {...inner} />
      </>
    );
  }
  if (shape === 'oct') {
    return (
      <>
        <polygon
          points="110.8,81 81,110.8 39,110.8 9.2,81 9.2,39 39,9.2 81,9.2 110.8,39"
          {...outer}
        />
        <polygon
          points="103.4,78 78,103.4 42,103.4 16.6,78 16.6,42 42,16.6 78,16.6 103.4,42"
          {...inner}
        />
      </>
    );
  }
  if (shape === 'oval') {
    return (
      <>
        <ellipse cx="60" cy="60" rx="56" ry="48" {...outer} />
        <ellipse cx="60" cy="60" rx="49" ry="41" {...inner} />
      </>
    );
  }
  if (shape === 'shield') {
    return (
      <>
        <path d="M60 6 L110 20 L106 76 Q60 114 14 76 L10 20 Z" {...outer} />
        <path d="M60 16 L100 28 L97 74 Q60 102 23 74 L20 28 Z" {...inner} />
      </>
    );
  }
  return (
    <>
      <circle cx="60" cy="60" r="56" {...outer} />
      <circle cx="60" cy="60" r="46" {...inner} />
    </>
  );
}

function IconShapes({ markup }: { markup: string }) {
  const nodes: ReactNode[] = [];
  const tags = /<(circle|path|ellipse|polygon|rect)\s+([^>]*?)\s*\/?>/g;
  for (const match of markup.matchAll(tags)) {
    const tag = match[1];
    const raw = match[2] ?? '';
    if (!tag) continue;
    const props: Record<string, string> = {};
    for (const attr of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const key = attr[1];
      const value = attr[2];
      if (key && value !== undefined) props[key] = value;
    }
    nodes.push(createElement(tag, { ...props, key: nodes.length }));
  }
  return nodes;
}
