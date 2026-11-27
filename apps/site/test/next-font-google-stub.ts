/** Vitest stand-in for next/font/google. The Next compiler replaces that import
 * at build time; this runner does not, and the package file is empty. */
export function Caveat_Brush(): { className: string; style: { fontFamily: string } } {
  return { className: 'font-caveat-brush', style: { fontFamily: 'Caveat Brush, cursive' } };
}
