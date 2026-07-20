'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { LogoMark } from '~/components/hale/logo-mark';

/**
 * Step 7's "Hale is getting things ready…" animated checklist (design handoff
 * §4.1 Ob7). Six setup lines reveal one-by-one (~450ms apart), each fading in and
 * turning its dot to a green check; ~1s after the last fills, it calls onDone to
 * advance. All timers are cleared on unmount / re-run (the task's explicit
 * requirement) so a fast Back never leaves a stray timer firing setState.
 *
 * The lines are honest process narration — the real work IS underway
 * (completeOnboarding ran before this view, triggering the family's first-village
 * discovery). Nothing here fabricates a count or a stat.
 */

const READY_LINES = [
  'Reading the Canadian milestone schedule',
  'Finding nearby programs and activities',
  'Creating a health & vaccine timeline',
  'Organizing your family calendar',
  'Saving your first milestones',
  'Preparing personalized tips',
] as const;

const REVEAL_MS = 450;
const HOLD_AFTER_FILL_MS = 1000;

export function GettingReadyChecklist({ onDone }: { onDone: () => void }) {
  const [revealed, setRevealed] = useState(1);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 2; i <= READY_LINES.length; i += 1) {
      timers.push(setTimeout(() => setRevealed(i), REVEAL_MS * (i - 1)));
    }
    timers.push(
      setTimeout(
        () => onDoneRef.current(),
        REVEAL_MS * (READY_LINES.length - 1) + HOLD_AFTER_FILL_MS,
      ),
    );
    return () => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
  }, []);

  return (
    <section className="ob-step">
      <div className="ob-bubble">
        <LogoMark size={30} className="ob-bubble-avatar" />
        <p>Hale is getting things ready…</p>
      </div>

      <ul className="ob-ready-list" aria-live="polite">
        {READY_LINES.map((line, i) => {
          const isOn = i < revealed;
          return (
            <li key={line} className={isOn ? 'ob-ready-item ob-ready-on' : 'ob-ready-item'}>
              <span className="ob-ready-dot" aria-hidden="true">
                {isOn ? <Check size={13} strokeWidth={3} /> : null}
              </span>
              <span>{line}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
