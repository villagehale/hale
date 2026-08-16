'use client';

import { useEffect, useRef } from 'react';
import {
  type Layout,
  LEAD_ENTRANCE_MS,
  poseAt,
  ramp,
  trackForSlot,
  transformFor,
} from './choreography';
import { LEAD_SLOT, type Moment } from './moments';
import './pallet-v2b.css';

/**
 * The pinned stage: seven cards, four beats, one scroll.
 *
 * Every frame is written imperatively through refs — no React state is touched
 * while scrolling, so the cards never re-render and therefore can never remount
 * mid-choreography. (The template solves the same problem by keeping stable keys
 * across a fixed→absolute wrapper swap; keeping the elements out of the render
 * path entirely is the same guarantee with nothing to get wrong.) The pin itself
 * is `position: sticky`, which pins and releases at the track's own bounds.
 *
 * Only `transform` and `opacity` are written. Nothing here reads layout inside
 * the frame except one `getBoundingClientRect` on the track.
 */

const HERO_FADE = [0.02, 0.26] as const;
const CAP_IN = [0.22, 0.31] as const;
const CAP_OUT = [0.4, 0.5] as const;
const S2_FADE = [0.6, 0.8] as const;
const LADDER_PHASE_AT = 0.5;
const TAG_POP_AT = 0.72;

function readLayout(): Layout {
  if (window.matchMedia('(min-width: 1200px)').matches) return 'desktop';
  if (window.matchMedia('(min-width: 768px)').matches) return 'tablet';
  return 'mobile';
}

export function PalletDeck({
  moments,
  children,
}: {
  moments: readonly Moment[];
  /** Hero copy, stack caption and section-two copy, as three positioned layers. */
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const track = root.querySelector<HTMLElement>('[data-v2b="track"]');
    const deck = root.querySelector<HTMLElement>('[data-v2b="deck"]');
    const hero = root.querySelector<HTMLElement>('[data-v2b="hero"]');
    const cap = root.querySelector<HTMLElement>('[data-v2b="cap"]');
    const s2 = root.querySelector<HTMLElement>('[data-v2b="s2"]');
    const tags = root.querySelector<HTMLElement>('[data-v2b="tags"]');
    const header = root.querySelector<HTMLElement>('[data-v2b="header"]');
    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-v2b="card"]'));
    if (!track || !deck || !hero || !cap || !s2) return;

    let layout = readLayout();
    let tracks = cards.map((_, i) => trackForSlot(i, layout));
    let raf = 0;
    let lastP = Number.NaN;
    let phase = '';
    let popped = false;
    let stuck = false;
    let introTimer = 0;
    let handedOver = false;

    /** Stop the CSS intro and let the scroll loop own the transforms from here. */
    const handOver = () => {
      if (handedOver) return;
      handedOver = true;
      window.clearTimeout(introTimer);
      deck.dataset.intro = 'done';
    };

    const paint = () => {
      raf = 0;
      const rect = track.getBoundingClientRect();
      const span = track.offsetHeight - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -rect.top / span)) : 0;

      if (p > 0.004) handOver();

      const nextStuck = rect.top < -8;
      if (nextStuck !== stuck) {
        stuck = nextStuck;
        if (header) header.dataset.stuck = String(stuck);
      }

      if (Math.abs(p - lastP) < 0.0004) return;
      lastP = p;

      if (handedOver) {
        cards.forEach((card, i) => {
          card.style.transform = transformFor(
            poseAt(tracks[i] as ReturnType<typeof trackForSlot>, p),
          );
        });
      }

      const heroOpacity = 1 - ramp(p, HERO_FADE[0], HERO_FADE[1]);
      hero.style.opacity = heroOpacity.toFixed(3);
      hero.style.visibility = heroOpacity < 0.02 ? 'hidden' : 'visible';

      const capOpacity = Math.min(
        ramp(p, CAP_IN[0], CAP_IN[1]),
        1 - ramp(p, CAP_OUT[0], CAP_OUT[1]),
      );
      cap.style.opacity = capOpacity.toFixed(3);

      const s2Opacity = ramp(p, S2_FADE[0], S2_FADE[1]);
      s2.style.opacity = s2Opacity.toFixed(3);
      s2.style.visibility = s2Opacity < 0.02 ? 'hidden' : 'visible';

      const nextPhase = p < LADDER_PHASE_AT ? 'fan' : 'ladder';
      if (nextPhase !== phase) {
        phase = nextPhase;
        deck.dataset.phase = phase;
      }

      if (tags && !popped && p >= TAG_POP_AT) {
        popped = true;
        tags.dataset.pop = 'true';
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };

    /** Reduce-motion collapses the whole stage into ordinary document flow. */
    const applyMotionPreference = () => {
      if (reduced.matches) {
        root.dataset.static = 'true';
        window.clearTimeout(introTimer);
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', onResize);
        return;
      }
      root.dataset.static = 'false';
      introTimer = window.setTimeout(handOver, LEAD_ENTRANCE_MS + 60);
      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', onResize);
      schedule();
    };

    function onResize() {
      const next = readLayout();
      if (next !== layout) {
        layout = next;
        tracks = cards.map((_, i) => trackForSlot(i, layout));
      }
      lastP = Number.NaN;
      schedule();
    }

    applyMotionPreference();
    reduced.addEventListener('change', applyMotionPreference);

    return () => {
      window.clearTimeout(introTimer);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      reduced.removeEventListener('change', applyMotionPreference);
    };
  }, []);

  return (
    <div ref={rootRef} className="v2b" data-static="false">
      {children}
    </div>
  );
}

/** One card: a styled miniature of a real Hale exchange. Never an image. */
export function MomentCard({ moment }: { moment: Moment }) {
  return (
    <article
      data-v2b="card"
      data-slot={moment.slot}
      className="v2b-card"
      aria-label={moment.label}
      style={
        {
          '--zfan': 10 - Math.abs(moment.slot - LEAD_SLOT),
          '--zslot': moment.slot,
        } as React.CSSProperties
      }
      data-lead={moment.lead ? 'true' : undefined}
    >
      <div className="v2b-card-face">
        <span className={`v2b-card-tag v2b-card-tag-${moment.tone}`}>{moment.tag}</span>

        {moment.bubbles && (
          <ol className="v2b-card-thread">
            {moment.bubbles.map((bubble) => (
              <li
                key={bubble.text}
                className={`v2b-card-bubble v2b-card-bubble-${bubble.from}`}
              >
                <span className="sr-only">{bubble.from === 'parent' ? 'Parent: ' : 'Hale: '}</span>
                {bubble.text}
              </li>
            ))}
          </ol>
        )}

        {moment.ics && (
          <p className="v2b-ics">
            <span className="v2b-ics-chip">ICS</span>
            <span>
              {moment.ics.title} · {moment.ics.when}
            </span>
          </p>
        )}

        {moment.brief && (
          <div className="v2b-brief">
            <p className="v2b-brief-head">
              <span>{moment.brief.stamp}</span>
              <span>Email</span>
            </p>
            <p className="v2b-brief-title">{moment.brief.title}</p>
            <ul className="v2b-brief-rows">
              {moment.brief.rows.map((row, i) => (
                <li key={row} className="v2b-brief-row">
                  <span
                    aria-hidden="true"
                    className="v2b-brief-dot"
                    style={{ background: i === 1 ? 'var(--v2b-amber)' : 'var(--v2b-faint)' }}
                  />
                  {row}
                </li>
              ))}
            </ul>
          </div>
        )}

        {moment.note && <p className="v2b-card-note">{moment.note}</p>}
      </div>
    </article>
  );
}
