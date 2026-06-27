import type { PropsWithChildren } from 'react';
import Link from 'next/link';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

/**
 * The shared sign-in / sign-up frame: a two-panel split on lg+ — a Spruce brand
 * panel on the left (the white turtle on its Prussian field, extended to a full
 * panel) and the form column on the right, vertically centered. Below lg the
 * brand panel folds away and the form sits centered, so there is no horizontal
 * overflow on a narrow phone. The brand panel uses bg-spruce / text-on-spruce
 * like the other public Spruce-field pages, so it inverts correctly in dark mode.
 */
export function AuthShell({ heading, children }: PropsWithChildren<{ heading: string }>) {
  return (
    <main className="min-h-[100dvh] bg-linen lg:grid lg:grid-cols-2">
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-6 pt-8 lg:px-10">
        <Link href="/" className="flex items-center gap-3 lg:invisible">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold">Hale</span>
        </Link>
        <ThemeToggle />
      </header>

      <section className="bg-spruce text-on-spruce hidden lg:flex flex-col justify-between px-12 py-14 xl:px-16">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={36} />
          <span className="font-display text-2xl font-semibold text-on-spruce">Hale</span>
        </Link>
        <div className="max-w-md">
          <p className="eyebrow text-on-spruce-soft">For your family</p>
          <p className="mt-4 font-display text-[clamp(2.4rem,3.4vw,3.4rem)] font-semibold leading-[1.05] tracking-[-0.02em] text-on-spruce text-balance">
            The <span className="text-apricot-deep">village</span> every parent needs.
          </p>
          <p className="mt-6 text-lg leading-relaxed text-on-spruce-soft">
            Real recommendations from real families near you, with a calm AI concierge that finds
            and organizes it all — for every stage of childhood.
          </p>
        </div>
        <p className="text-on-spruce-faint text-sm">Hale · the village every parent needs</p>
      </section>

      <section className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-24 lg:min-h-0 lg:py-16">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <h2 className="font-display text-3xl font-semibold leading-tight">{heading}</h2>
          {children}
        </div>
      </section>
    </main>
  );
}
