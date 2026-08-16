import { encode } from 'uqr';

/**
 * The sms: URI as a scannable code, drawn inline from the module grid — no
 * network, no third-party chart endpoint, nothing for a CSP to allow.
 *
 * It carries its OWN light plate and dark modules rather than reading the theme
 * tokens. A QR code is not decoration: drawn in --color-spruce on the card it
 * sits on, dark mode inverted it to cream-on-navy, which many scanners refuse.
 * The `border: 2` quiet zone is inside the grid, so the plate covers it too.
 *
 * Shared by /text (the QR cards' landing surface) and the persona landing, so
 * both desktop paths render the identical code from the identical URI.
 */

/** Fixed, theme-independent: a code must be dark-on-light to be scannable. */
const PLATE = '#ffffff';
const MODULE = '#17294a';
export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  const { size: modules, data } = encode(value, { ecc: 'M', border: 2 });

  let path = '';
  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }
  }

  return (
    <svg
      role="img"
      aria-label="QR code — scan to text Hale"
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0"
      style={{ borderRadius: 6 }}
    >
      <rect width={modules} height={modules} fill={PLATE} />
      <path d={path} fill={MODULE} />
    </svg>
  );
}
