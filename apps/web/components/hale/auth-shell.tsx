import type { PropsWithChildren } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

/**
 * The shared sign-in / sign-up frame: a centered split card floating on a
 * full-viewport Prussian-navy stage. The left panel is a deep-navy gradient stage
 * carrying the brand — the alpha-matted village illustration (decorative), the
 * serif wordmark, and the value copy in cream — and stays navy in BOTH themes (the
 * brand field is a navy stage regardless of light/dark). The right panel is the
 * form column on the app's token surfaces, so it flips warm-white → deep-navy-tinted
 * with the theme toggle (which stays). Below 900px the card stacks to a column: the
 * stage folds to a compact brand band (illustration + lede hidden) above the form,
 * so a phone shows the brand then the form with no horizontal overflow.
 */
export function AuthShell({
  heading,
  subtitle,
  children,
}: PropsWithChildren<{ heading: string; subtitle?: string }>) {
  return (
    <div className="auth-backdrop">
      <main className="auth-card">
        <section className="auth-stage">
          <Link href="/" className="auth-stage-mark">
            <LogoMark size={34} />
            Hale
          </Link>
          <div className="auth-stage-art">
            <Image
              src="/village-illustration.png"
              alt=""
              aria-hidden="true"
              fill
              sizes="(max-width: 900px) 0px, 460px"
              className="object-contain"
            />
          </div>
          <div className="auth-stage-copy">
            <p className="auth-stage-eyebrow">For your neighborhood</p>
            <p className="auth-stage-title">
              The <span className="auth-stage-accent">village</span> every parent needs.
            </p>
            <p className="auth-stage-lede">
              Real recommendations from real families near you, with Hale, a calm AI co-pilot that
              finds and organizes it all — for every stage of childhood.
            </p>
          </div>
        </section>

        <section className="auth-panel">
          <div className="auth-panel-head">
            <ThemeToggle />
          </div>
          <h1 className="auth-heading">{heading}</h1>
          {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
          {children}
          <p className="meta">
            Your family&rsquo;s data stays in Canada. Nothing is shared until you say so.
          </p>
        </section>
      </main>
    </div>
  );
}
