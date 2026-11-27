/** Vitest stand-in for next/font/google. The Next compiler replaces that import
 * at build time; this runner does not, and the package file is empty. */
function face(className: string, fontFamily: string) {
  return { className, style: { fontFamily } };
}

export function Caveat_Brush() {
  return face('font-caveat-brush', 'Caveat Brush, cursive');
}

export function Inter() {
  return face('font-inter', 'Inter, sans-serif');
}

export function DM_Mono() {
  return face('font-dm-mono', 'DM Mono, monospace');
}
