'use client';

import { ArrowLeft, ArrowRight } from 'lucide-react';
import Image, { type StaticImageData } from 'next/image';
import { Fragment, useEffect, useState } from 'react';
import celebrate from '~/assets/hale-turtle-celebrate-alpha.png';
import excited from '~/assets/hale-turtle-excited-alpha.png';
import wave from '~/assets/hale-turtle-wave-alpha.png';

/**
 * The word-by-word testimonial slider — gated behind
 * NEXT_PUBLIC_SHOW_TESTIMONIALS (default OFF). Real beta-parent quotes are not
 * collected yet, so the data below is PLACEHOLDER and must never render in prod.
 * The page also gates on the same flag; this early return is a second guard.
 *
 * Avatars use the Hale mascot on tinted circles (decorative) — never stock
 * photos of real people, and never real family identities.
 */

type Testimonial = {
  quote: string;
  name: string;
  role: string;
  avatar: StaticImageData;
  tint: string;
};

// PLACEHOLDER — awaiting real beta-parent quotes. First-name-only shape.
// Never shown in production (NEXT_PUBLIC_SHOW_TESTIMONIALS defaults to off).
const PLACEHOLDER_TESTIMONIALS: readonly Testimonial[] = [
  {
    quote: 'This is placeholder testimonial copy, shown only when the preview flag is on.',
    name: 'Sarah',
    role: 'mom of two',
    avatar: wave,
    tint: '#EDF0FA',
  },
  {
    quote: 'Another placeholder quote — real beta-parent words will replace this before launch.',
    name: 'Priya',
    role: 'mom of one',
    avatar: excited,
    tint: '#E7F6EC',
  },
  {
    quote: 'Placeholder text standing in for a genuine family story we have not collected yet.',
    name: 'Marcus',
    role: 'dad of three',
    avatar: celebrate,
    tint: '#FEF0C7',
  },
] as const;

const ENABLED = process.env.NEXT_PUBLIC_SHOW_TESTIMONIALS === 'true';

export function Testimonials() {
  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  if (!ENABLED) return null;

  const count = PLACEHOLDER_TESTIMONIALS.length;
  const current = PLACEHOLDER_TESTIMONIALS[index];
  if (!current) return null;

  const go = (delta: number) => setIndex((i) => (i + delta + count) % count);
  const words = current.quote.split(' ');

  return (
    <section aria-label="What families say" className="bg-[#F7F5F0] px-6 py-24 md:py-32">
      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8B95A9]">
          • Testimonials
        </p>

        <blockquote
          key={index}
          className="mt-8 text-[28px] font-normal leading-[1.25] tracking-tight text-[#17294A] md:text-[54px]"
        >
          {words.map((word, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static word split that never reorders — the index disambiguates repeated words.
            <Fragment key={`${word}-${i}`}>
              <span
                className={reduced ? undefined : 'hale-quote-word'}
                style={{
                  display: 'inline-block',
                  opacity: reduced ? 1 : 0,
                  animationDelay: reduced ? undefined : `${i * 0.04}s`,
                }}
              >
                {word}
              </span>{' '}
            </Fragment>
          ))}
        </blockquote>

        <div
          key={`author-${index}`}
          className="mt-10 flex flex-col items-center"
          style={
            reduced
              ? undefined
              : { opacity: 0, animation: 'hale-fade-up 640ms var(--ease-breathe) 0.4s both' }
          }
        >
          <span
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: current.tint }}
          >
            <Image
              src={current.avatar}
              alt=""
              aria-hidden
              width={48}
              height={48}
              className="h-12 w-12 object-contain"
            />
          </span>
          <p className="mt-3 text-base font-semibold text-[#17294A]">{current.name}</p>
          <p className="text-sm text-[#5C6B87]">{current.role}</p>
        </div>

        <div className="mt-12 flex items-center justify-center gap-4">
          <button
            type="button"
            aria-label="Previous testimonial"
            onClick={() => go(-1)}
            className="group flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B2160] transition-colors hover:bg-[#141a4d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
          >
            <ArrowLeft
              size={22}
              strokeWidth={1.5}
              color="#E0A44E"
              className="transition-transform group-hover:-translate-x-0.5"
            />
          </button>
          <button
            type="button"
            aria-label="Next testimonial"
            onClick={() => go(1)}
            className="group flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B2160] transition-colors hover:bg-[#141a4d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1B2160]"
          >
            <ArrowRight
              size={22}
              strokeWidth={1.5}
              color="#E0A44E"
              className="transition-transform group-hover:translate-x-0.5"
            />
          </button>
        </div>
      </div>
    </section>
  );
}
