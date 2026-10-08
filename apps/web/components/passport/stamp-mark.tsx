import { type ReactNode, createElement } from 'react';
import { STAMP_ICONS } from '~/lib/passport/icons';

type Shape = 'circle' | 'rect' | 'oct' | 'oval' | 'shield' | 'pentagon';

type Profile = {
  shape: Shape;
  tilt: number;
  arc: boolean;
  ink: string;
  nameSize: number;
  tracking: number;
  nameY: number;
  dateY: number;
  dateSize: number;
  icon: string;
};

/** Gallery shapes. Soccer is a circle, Karate a shield. Hockey and Basketball differ. */
const PROFILES: Record<string, Profile> = {
  soccer: profile(
    'circle',
    -6,
    true,
    '#1B2160',
    13,
    1,
    0,
    88,
    10.5,
    'translate(45 46) scale(1.25)',
  ),
  swimming: profile(
    'rect',
    4,
    false,
    '#2E6DA4',
    13,
    0.6,
    68,
    90,
    10.5,
    'translate(46 26) scale(1.17)',
  ),
  skating: profile(
    'oct',
    -3,
    false,
    '#5B3A7A',
    12.5,
    1,
    67,
    82,
    10,
    'translate(46.5 27.5) scale(1.125)',
  ),
  zoo: profile('oval', 7, false, '#3F6B3A', 13, 1, 69, 84, 10, 'translate(46.5 28.5) scale(1.125)'),
  karate: profile(
    'shield',
    -8,
    false,
    '#9A3B26',
    12.5,
    1,
    67,
    82,
    10,
    'translate(46.5 27.5) scale(1.125)',
  ),
  aquarium: profile(
    'circle',
    5,
    true,
    '#0F766E',
    11,
    0.4,
    0,
    88,
    10.5,
    'translate(45 46) scale(1.25)',
  ),
  ballet: profile(
    'rect',
    -2,
    false,
    '#5B3A7A',
    14,
    1.2,
    68,
    90,
    10.5,
    'translate(46 26) scale(1.17)',
  ),
  farm: profile(
    'oct',
    6,
    false,
    '#9A3B26',
    12.5,
    1,
    67,
    82,
    10,
    'translate(46.5 27.5) scale(1.125)',
  ),
  hockey: profile(
    'pentagon',
    -5,
    false,
    '#1A3A5C',
    12,
    0.6,
    70,
    84,
    10,
    'translate(46.5 30) scale(1.05)',
  ),
  basketball: profile(
    'circle',
    4,
    false,
    '#B45309',
    10,
    0.1,
    72,
    86,
    10,
    'translate(48 32) scale(1)',
  ),
  dance: profile(
    'oval',
    3,
    false,
    '#7A3E6D',
    13,
    1,
    69,
    84,
    10,
    'translate(46.5 28.5) scale(1.125)',
  ),
  museum: profile(
    'oct',
    -4,
    false,
    '#243056',
    12,
    0.6,
    67,
    82,
    10,
    'translate(46.5 27.5) scale(1.125)',
  ),
  'christmas-market': profile(
    'rect',
    5,
    false,
    '#8C3A2F',
    11,
    0.2,
    68,
    88,
    10,
    'translate(46 26) scale(1.1)',
  ),
  'figure-skating': profile(
    'oval',
    -4,
    false,
    '#6D28A8',
    11,
    0.2,
    69,
    84,
    10,
    'translate(46.5 28.5) scale(1.05)',
  ),
  baseball: profile(
    'circle',
    6,
    false,
    '#9F1239',
    12,
    0.4,
    70,
    84,
    10,
    'translate(48 32) scale(1)',
  ),
  golf: profile(
    'oval',
    -6,
    false,
    '#3F6212',
    13,
    1,
    69,
    84,
    10,
    'translate(46.5 28.5) scale(1.125)',
  ),
};

const LITES: Record<string, string> = {
  '#1B2160': '#C5CAF5',
  '#2E6DA4': '#B9D7F2',
  '#5B3A7A': '#E0D0F0',
  '#3F6B3A': '#C9E4C4',
  '#9A3B26': '#F3C7BC',
  '#0F766E': '#B7E6E0',
  '#1A3A5C': '#C5D4EA',
  '#B45309': '#F6C99A',
  '#7A3E6D': '#F3C4E4',
  '#243056': '#C9D2EA',
  '#8C3A2F': '#F3C4BA',
  '#6D28A8': '#E4C8F5',
  '#9F1239': '#F6C2CE',
  '#3F6212': '#D5E8B0',
};

function profile(
  shape: Shape,
  tilt: number,
  arc: boolean,
  ink: string,
  nameSize: number,
  tracking: number,
  nameY: number,
  dateY: number,
  dateSize: number,
  icon: string,
): Profile {
  return { shape, tilt, arc, ink, nameSize, tracking, nameY, dateY, dateSize, icon };
}

function hash(id: string): number {
  let h = 0;
  for (const char of id) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h;
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
  const known = PROFILES[icon];
  const ink = known?.ink ?? '#1B2160';
  const shape = known?.shape ?? (kind === 'outing' ? 'circle' : 'rect');
  const tilt = known?.tilt ?? [-6, -4, 4, 6][hash(id) % 4] ?? -4;
  const arc = known?.arc ?? (shape === 'circle' && top.length <= 8);
  const nameSize = known?.nameSize ?? (top.length > 8 ? 10 : 13);
  const tracking = known?.tracking ?? (top.length > 8 ? 0.15 : 1);
  const nameY = known?.nameY ?? 68;
  const dateY = known?.dateY ?? 86;
  const dateSize = known?.dateSize ?? 10;
  const iconTransform = known?.icon ?? 'translate(46 28) scale(1.1)';
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
      <g filter={`url(#wear-${safe})`}>
        <Edges shape={shape} inferred={inferred} />
        {paths && !mini ? (
          <g
            transform={iconTransform}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <IconShapes markup={paths} />
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

function Edges({ shape, inferred }: { shape: Shape; inferred: boolean }) {
  const dash = inferred ? '5 4' : undefined;
  const outer = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 3,
    strokeDasharray: dash,
    className: 'pp-stamp-edge',
  };
  const inner = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.2,
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
  if (shape === 'pentagon') {
    return (
      <>
        <polygon points={pentagon(54)} {...outer} />
        <polygon points={pentagon(46)} {...inner} />
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

function pentagon(radius: number): string {
  return Array.from({ length: 5 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 5;
    const x = 60 + radius * Math.cos(angle);
    const y = 62 + radius * Math.sin(angle);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
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
