'use client';

import { useEffect, useState } from 'react';
import { CopyNumberButton } from '~/components/copy-number';
import { EmailCta } from '~/components/email-cta';
import { LandingCta } from '~/components/landing-cta';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { CONTACT_EMAIL, buildSmsBody, buildSmsHrefForBody } from '~/lib/text-entry';

/**
 * The hero: Hale types its real opening message, and the parent picks what to
 * say back.
 *
 * GREETING is `greeting(null)` from apps/web/lib/channel/intake/copy.ts — the
 * exact words a stranger's phone receives, re-set with the site's curly quotes
 * and em dashes (WORDS match; punctuation is display-layer). The preview test
 * reads that file off disk and fails if the two ever drift, because a landing
 * page that demonstrates a message Hale does not send is the one lie this page
 * cannot afford.
 *
 * The bubble is a 1×1 grid holding two copies of the greeting: an invisible
 * sizer that gives the box its final height from the first frame, and the typed
 * slice painted on top of it. Nothing below the bubble moves while it types, and
 * the whole message is real text in the DOM for a crawler. A screen reader gets
 * it once, whole, from the sr-only copy — a paragraph that announces itself one
 * character at a time is unusable.
 */

/** Hale's real cold-start greeting. Pinned against intake/copy.ts by the tests. */
export const GREETING =
  'Hi, I’m Hale — an AI that quietly runs the family week. Registration dates, weekend plans, the stuff that slips. Tell me your kids’ names and ages, plus your postal code — and I’ll get to work.';

const MS_PER_CHAR = 38;

/**
 * The four questions the strip offers. Every one is a thing Hale answers today,
 * and the source named beside it is the code that answers it — a chip a parent
 * taps must not open a conversation the product cannot finish.
 */
const ASKS = [
  // coaching-playbooks.ts: 'solids' is one of the three PlaybookTopic values.
  // Mia is the younger child in the example thread further down the page.
  'When should Mia start solids?',
  // The registration radar — the seeded windows behind the fifteen municipalities.
  'Watch registration dates for us',
  // ask-hale.md gives the calendar tool for exactly "am I free Saturday morning?",
  // and the greeting above already promises weekend plans.
  'What can we do Saturday morning?',
  // health/checkpoints.ts — the Ontario health-ADMIN windows. A parent may ask;
  // Hale answers with what the province schedules, never a claim about the child.
  'Is a checkup due?',
] as const;

/**
 * Reveals `text` one character at a time. Starts empty on the server and in the
 * first client frame, so there is no flash of the finished paragraph before the
 * typing begins; the sizer beside it holds the box open in the meantime. Under
 * prefers-reduced-motion the message is simply whole, and no caret is rendered.
 */
function useTypewriter(text: string, msPerChar: number) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCount(text.length);
      return;
    }
    setStarted(true);
  }, [text.length]);

  useEffect(() => {
    if (!started || count >= text.length) return;
    const id = window.setTimeout(() => setCount(count + 1), msPerChar);
    return () => window.clearTimeout(id);
  }, [started, count, text.length, msPerChar]);

  return {
    typed: text.slice(0, count),
    typing: started && count < text.length,
    finish: () => setCount(text.length),
  };
}

export function HeroConversation({ smsNumber }: { smsNumber: string }) {
  const { typed, typing, finish } = useTypewriter(GREETING, MS_PER_CHAR);
  const [picked, setPicked] = useState<string | null>(null);
  const [handOff, setHandOff] = useState(false);
  const capture = useAnalytics();

  // A touch device is the one place `sms:` opens something, so it is the one
  // place a chip can go straight to the composer. Everywhere else the chip
  // writes the draft below and the button sends it. Capability, not user agent.
  useEffect(() => {
    setHandOff(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  const body = picked ?? buildSmsBody(null);
  const href = smsNumber ? buildSmsHrefForBody(smsNumber, body) : null;

  function choose(ask: string) {
    finish();
    setPicked(ask);
    if (!smsNumber || !handOff) return;
    capture('landing_cta_text');
    window.location.href = buildSmsHrefForBody(smsNumber, ask);
  }

  return (
    <div className="v3-thread flex flex-col items-stretch gap-6 text-center">
      <p className="meta">Hale texts like this — this is its real opening message</p>

      <p className="v3-bubble rise rise-1 text-left">
        <span className="sr-only">Hale: {GREETING}</span>
        <span className="v3-bubble-sizer" aria-hidden="true">
          {GREETING}
        </span>
        <span aria-hidden="true">
          {typed}
          {typing && <span className="v3-caret" />}
        </span>
      </p>

      {/* With JavaScript off nothing types, so the copy that was only ever there
          to size the box becomes the message itself. */}
      <noscript>
        <style>{'.v3-bubble-sizer{visibility:visible}'}</style>
      </noscript>

      <div className="rise rise-2">
        <p className="eyebrow" id="v3-asks-label">
          Pick a question and I’ll write the text
        </p>
        <ul
          aria-labelledby="v3-asks-label"
          className="mt-4 flex flex-wrap justify-center gap-2.5"
        >
          {ASKS.map((ask) => (
            <li key={ask}>
              <button
                type="button"
                className="v3-chip"
                aria-pressed={picked === ask}
                onClick={() => choose(ask)}
              >
                {ask}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {href ? (
        <div id="start" className="rise rise-3 flex flex-col gap-4">
          <p className="v3-draft">
            <span className="v3-draft-label">Your first text</span>
            <span className="v3-draft-body">{body}</span>
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <LandingCta event="landing_cta_text" href={href} className="btn-primary">
              Text me
            </LandingCta>
            <CopyNumberButton number={smsNumber} />
          </div>
          <p className="meta">
            You send it; I never text first. Standard message rates apply; reply STOP any time.
          </p>
        </div>
      ) : (
        <div id="start" className="rise rise-3 flex flex-col gap-4">
          <EmailCta email={CONTACT_EMAIL} buttonClassName="btn-primary" />
          <p className="meta">
            The number’s coming. Until it answers, email is the honest way to reach me.
          </p>
        </div>
      )}
    </div>
  );
}
