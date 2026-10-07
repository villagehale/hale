import { type ReactNode, createElement } from 'react';
import { STAMP_ICONS } from '~/lib/passport/icons';

const SHAPES = ['circle', 'rect', 'oct', 'oval', 'shield'] as const;

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
}: {
  id: string;
  icon: string;
  kind: 'activity' | 'outing';
  inferred: boolean;
  top: string;
  bottom: string;
}) {
  const shape = kind === 'outing' ? 'circle' : SHAPES[hash(id) % SHAPES.length];
  const size = kind === 'outing' ? 86 : 112;
  const rotation = (hash(id) % 17) - 8;
  const ink = inkFor(icon);
  const paths = STAMP_ICONS[icon] ?? '';
  return (
    <svg
      className={inferred ? 'pp-stamp is-inferred' : 'pp-stamp'}
      width={size}
      height={size}
      viewBox="0 0 112 112"
      role="img"
      aria-label={`${top} ${bottom}`}
      style={{
        transform: `rotate(${rotation}deg)`,
        ['--stamp-ink' as string]: ink,
        ['--stamp-ink-lite' as string]: inkLite(ink),
      }}
    >
      <title>{`${top} ${bottom}`}</title>
      <Shape name={shape ?? 'circle'} />
      {paths ? (
        <g
          transform="translate(44 40)"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <IconShapes markup={paths} />
        </g>
      ) : null}
      <text x="56" y="28" textAnchor="middle" className="pp-stamp-top">
        {top}
      </text>
      <text x="56" y="96" textAnchor="middle" className="pp-stamp-bottom">
        {bottom}
      </text>
    </svg>
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

function Shape({ name }: { name: (typeof SHAPES)[number] }) {
  const props = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    className: 'pp-stamp-edge',
  };
  if (name === 'rect') return <rect x="16" y="14" width="80" height="84" rx="8" {...props} />;
  if (name === 'oct') {
    return <polygon points="34,14 78,14 98,34 98,78 78,98 34,98 14,78 14,34" {...props} />;
  }
  if (name === 'oval') return <ellipse cx="56" cy="56" rx="40" ry="46" {...props} />;
  if (name === 'shield') {
    return <path d="M56 12l36 14v28c0 22-16 36-36 46C36 90 20 76 20 54V26z" {...props} />;
  }
  return <circle cx="56" cy="56" r="44" {...props} />;
}

function inkFor(icon: string): string {
  const inks: Record<string, string> = {
    soccer: '#1B2160',
    swimming: '#2E6DA4',
    skating: '#5B3A7A',
    hockey: '#1B2160',
    zoo: '#3F6B3A',
    karate: '#9A3B26',
    aquarium: '#0F766E',
    ballet: '#5B3A7A',
    farm: '#9A3B26',
    museum: '#1B2160',
    'christmas-market': '#9A3B26',
  };
  return inks[icon] ?? '#1B2160';
}

/** Lighter ink so a stamp stays readable on #17294a. */
function inkLite(ink: string): string {
  const lites: Record<string, string> = {
    '#1B2160': '#C5CAF5',
    '#2E6DA4': '#B9D7F2',
    '#5B3A7A': '#E0D0F0',
    '#3F6B3A': '#C9E4C4',
    '#9A3B26': '#F3C7BC',
    '#0F766E': '#B7E6E0',
  };
  return lites[ink] ?? '#E4E9F7';
}
