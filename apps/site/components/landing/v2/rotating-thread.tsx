'use client';

import { useEffect, useState } from 'react';

/**
 * The landing-v2 signature: one frosted card on the navy band, cycling three
 * real exchanges — the radar, the coaching, the approval. It is the page's only
 * loud element on purpose.
 *
 * ── Provenance (every word below traces to a shipped surface) ──────────────
 * Nothing here is written for the marketing page. Each reply is either verbatim
 * product copy or composed under the skill that governs that reply, from a
 * source-verified playbook — and the caption says exactly that, because these
 * are the messages Hale is built to send, not a screenshot of one family's
 * thread. Curly quotes and em dashes are the site's typographic render of the
 * plain-ASCII originals (the transport is GSM-7); WORDS match.
 *
 *  1 · the radar — both sides verbatim from the product tour (beat B), whose
 *      reply is composed per `packages/agent/skills/radar-voice.md` around the
 *      real Halton Hills row in apps/web/lib/registration/registration-windows-data.ts
 *      (rec_program, Fall 2026, residentOpenAt 2026-09-01T07:00-04:00,
 *      residentPriorityDays 7). The "still mapping" tail is kept: naming what it
 *      has not finished yet is the honesty the product actually ships.
 *  2 · the coaching — composed per `packages/agent/skills/coach-channel-sms.md`
 *      (lead with the thing to try; the offer sentence is that file's verbatim
 *      example) off the `solids` playbook in
 *      packages/types/src/coaching-playbooks.ts: iron-rich foods twice a day at
 *      about 6 months, then allergens one at a time, at home, because waiting
 *      does not protect (CPS/Health Canada; LEAP 2015, EAT 2016).
 *  3 · the approval — both sides verbatim from the product tour (beat F),
 *      composed per coach-channel-sms.md's draft shape: future tense, one
 *      question, and the literal word YES that the reply matcher accepts.
 */

const EXCHANGES = [
  {
    rail: 'The radar',
    eyebrow: 'It goes and looks',
    parent: 'Max is 4, Mia is 18 months, L7G 4S8',
    hale: [
      'I checked for Max and Mia — Halton Hills opens fall rec registration Tuesday, Sep 1 at 7 a.m., and as residents you get a 7-day head start before it opens to everyone.',
      'Still mapping what’s on near you this weekend — I’ll have a pick soon.',
    ],
  },
  {
    rail: 'The coaching',
    eyebrow: 'The 3 a.m. question',
    parent: 'when do we start solids? he’s 5 months next week',
    hale: [
      'Around 6 months, and start with iron-rich foods twice a day — iron-fortified cereal, well-cooked lentils, puréed meat. Then bring in the common allergens one at a time, at home, from about 6 months too: waiting doesn’t protect. Want the full plan? Reply YES and I’ll send it.',
    ],
  },
  {
    rail: 'Your say-so',
    eyebrow: 'Nothing leaves without it',
    parent: 'max has a bday party sat 2pm at riverdale farm',
    hale: ['Add Max’s birthday party — Sat, Aug 23 at 2pm, Riverdale Farm? YES to confirm.'],
  },
] as const;

/** How long one exchange holds, and how long its exit takes. Matches the
 * `v2-rail-fill` keyframe duration and the `.v2-swap` transition in globals.css. */
const DWELL_MS = 4000;
const EXIT_MS = 600;

export function RotatingThread() {
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  // Off until the client says motion is welcome: a reader on prefers-reduced-motion
  // gets the first exchange and the rail, and nothing moves on its own.
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setRotating(true);
  }, []);

  useEffect(() => {
    if (!rotating) return;
    // Exit first, then swap — the reference's "wait" ordering, so the two
    // exchanges never overlap mid-blur.
    const out = setTimeout(() => setLeaving(true), DWELL_MS - EXIT_MS);
    const advance = setTimeout(() => {
      setIndex((index + 1) % EXCHANGES.length);
      setLeaving(false);
    }, DWELL_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(advance);
    };
  }, [rotating, index]);

  /** The rail is a control, so using it hands the reader the wheel for good —
   * a carousel that resumes on its own steals the thing they just chose. */
  function select(next: number) {
    setRotating(false);
    setLeaving(false);
    setIndex(next);
  }

  return (
    <div data-rotating={rotating ? 'true' : 'false'}>
      {/* No wrapper role: the section heading beside the card names it, each panel
          opens with its own eyebrow, and the rail buttons carry their own labels. */}
      <div className="v2-glass grid p-6 sm:p-8">
        {EXCHANGES.map((exchange, i) => (
          <div
            key={exchange.rail}
            className="v2-swap"
            data-state={i === index ? (leaving ? 'leaving' : 'active') : 'idle'}
            aria-hidden={i === index ? undefined : 'true'}
          >
            <span className="eyebrow v2-stage-soft">{exchange.eyebrow}</span>
            <ol className="mt-5 flex flex-col gap-3">
              <li className="flex justify-end">
                <p className="v2-bubble-parent max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-[0.95rem]">
                  <span className="sr-only">Parent:</span>
                  {exchange.parent}
                </p>
              </li>
              <li className="flex justify-start">
                <div className="v2-bubble-hale max-w-[92%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-[0.95rem]">
                  <span className="sr-only">Hale:</span>
                  {exchange.hale.map((paragraph, p) => (
                    <p key={paragraph} className={p === 0 ? undefined : 'mt-3'}>
                      {paragraph}
                    </p>
                  ))}
                </div>
              </li>
            </ol>
          </div>
        ))}
      </div>

      <ul className="mt-6 grid grid-cols-3 gap-4">
        {EXCHANGES.map((exchange, i) => (
          <li key={exchange.rail}>
            <button
              type="button"
              className="v2-rail"
              aria-current={i === index ? 'true' : undefined}
              onClick={() => select(i)}
            >
              <span className="v2-rail-track" aria-hidden="true">
                <span className="v2-rail-fill" />
              </span>
              {exchange.rail}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
