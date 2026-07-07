import { LogoMark } from '~/components/hale/logo-mark';

/**
 * The branded wait — web's version of the mobile app-open splash: the turtle
 * chip enters with a soft overshoot and then breathes (CSS, --ease-breathe)
 * while real work resolves, with an optional quiet line beneath. Reduced
 * motion renders it static. Use only where the wait is unavoidable (route
 * loading boundaries, the preview generation) — never as a gate in front of
 * content that would otherwise paint immediately.
 */
export function TurtleLoader({ label }: { label?: string }) {
  return (
    <output className="flex flex-col items-center justify-center gap-4 py-16" aria-live="polite">
      <span className="turtle-loader-mark">
        <LogoMark size={72} />
      </span>
      {label ? <span className="turtle-loader-text meta">{label}</span> : null}
    </output>
  );
}
