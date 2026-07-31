import { encode } from 'uqr';

/**
 * The sms: URI as a scannable code, drawn inline from the module grid — no
 * network, no third-party chart endpoint, nothing for a CSP to allow. The white
 * card around it supplies the rest of the quiet zone.
 *
 * Shared by /text (the QR cards' landing surface) and the persona landing, so
 * both desktop paths render the identical code from the identical URI.
 */
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
    >
      <path d={path} fill="var(--color-spruce)" />
    </svg>
  );
}
