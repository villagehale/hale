'use client';

import { useState } from 'react';
import { PUSH_PREF_ROWS } from '~/components/hale/notification-prefs-rows';
import type { PushPrefsView } from '~/lib/push/prefs';
import type {
  LoadPushPrefsResult,
  PushPref,
} from '~/lib/settings/push-notification-prefs';
import { setPushNotificationPrefAction } from '~/lib/settings/push-prefs-actions';

/**
 * Settings → Notifications (design handoff §4.7). Renders EXACTLY the two push
 * streams the backend persists — new local picks + health reminders — as real
 * on/off switches. Both default on (the absence of a notification_prefs row IS
 * "both on"), and a toggle writes through the audited server action. We render no
 * category the store can't back (no email/appt/promo rows the prototype mocked) —
 * honesty over the mockup's fuller list (rule #1).
 */

const NOT_READY_NOTE: Record<Exclude<LoadPushPrefsResult['status'], 'ready'>, string> = {
  preview: 'Sign in to choose which reminders Hale sends you.',
  unauthenticated: 'Sign in to choose which reminders Hale sends you.',
  not_found: 'Finish setting up your family, then you can tune these.',
};

export function NotificationPrefs({ result }: { result: LoadPushPrefsResult }) {
  if (result.status !== 'ready') {
    return <p className="text-spruce leading-relaxed max-w-md">{NOT_READY_NOTE[result.status]}</p>;
  }
  return <PrefsForm initial={result.prefs} />;
}

function PrefsForm({ initial }: { initial: PushPrefsView }) {
  const [prefs, setPrefs] = useState<PushPrefsView>(initial);
  const [note, setNote] = useState<string | null>(null);

  async function toggle(pref: PushPref) {
    const next = !prefs[pref];
    setPrefs((current) => ({ ...current, [pref]: next }));
    setNote(null);
    const outcome = await setPushNotificationPrefAction(pref, next);
    if (outcome.status !== 'updated') {
      // The write didn't land — put the switch back and say so, never a silent lie.
      setPrefs((current) => ({ ...current, [pref]: !next }));
      setNote(
        outcome.status === 'not_found'
          ? 'Finish setting up your family, then you can tune these.'
          : "Couldn't save that just now — please try again.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-y-2">
      <ul className="flex flex-col divide-y divide-rule border-y border-rule">
        {PUSH_PREF_ROWS.map((row) => {
          const on = prefs[row.pref];
          return (
            <li key={row.pref} className="flex items-center justify-between gap-x-6 py-4">
              <div className="min-w-0">
                <span className="font-medium text-spruce">{row.label}</span>
                <p className="meta mt-0.5">{row.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={row.label}
                className="toggle-switch"
                onClick={() => toggle(row.pref)}
              >
                <span className="toggle-switch-knob" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {note ? (
        <p className="meta text-apricot-deep" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
