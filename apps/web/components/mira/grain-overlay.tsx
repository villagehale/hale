/**
 * Fixed-position grain overlay rendered into the body. CSS-only — no JS,
 * no runtime cost. The SVG turbulence filter is inlined as a data URL
 * in globals.css; this component only places the layer.
 */
export function GrainOverlay() {
  return <div className="grain" aria-hidden />;
}
