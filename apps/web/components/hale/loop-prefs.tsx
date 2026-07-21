'use client';

import { useState } from 'react';
import type {
  ChildNameLevel,
  LoopChannel,
  LoopPrefUpdate,
  LoopPrefsView,
} from '~/lib/loop/prefs';
import { setLoopPrefAction } from '~/lib/settings/loop-prefs-actions';
import type { LoadLoopPrefsResult } from '~/lib/settings/loop-prefs';

/**
 * Settings → Notifications → The Sunday Loop (VIL-216 · A5). Renders EXACTLY the
 * fields the loop_prefs store backs — exchange channel, per-category enables,
 * quiet hours, child-name privacy, weekly send time — each control tied to a real
 * column (a fabricated field is a type error, rule #1). Optimistic saves through
 * the audited server action; a failed write rolls the control back with a visible
 * note, never a silent lie. SMS renders disabled until the channel launches.
 */

const NOT_READY_NOTE: Record<Exclude<LoadLoopPrefsResult['status'], 'ready'>, string> = {
  preview: 'Sign in to set up your weekly loop.',
  unauthenticated: 'Sign in to set up your weekly loop.',
  not_found: 'Finish setting up your family, then you can tune your loop.',
};

const CATEGORY_ROWS: {
  field: 'catWeeklyPlan' | 'catReminder' | 'catApproval' | 'catAlert';
  label: string;
  description: string;
}[] = [
  { field: 'catWeeklyPlan', label: 'Weekly plan', description: 'Your Sunday look-ahead for the week.' },
  { field: 'catReminder', label: 'Reminders', description: 'Gentle nudges before the things that matter.' },
  { field: 'catApproval', label: 'Approvals', description: 'When Hale has something ready for your say-so.' },
  { field: 'catAlert', label: 'Alerts', description: 'The few things worth reaching you right away.' },
];

// Illustrative preview per privacy level (the same wording the renderer produces).
const NAME_LEVELS: { value: ChildNameLevel; label: string; preview: string }[] = [
  { value: 'first_name', label: 'First name', preview: 'Reminder: Maya’s swim at 4:30' },
  { value: 'relation', label: 'Relationship', preview: 'Reminder: your daughter’s swim at 4:30' },
  { value: 'generic', label: 'Generic', preview: 'Reminder: your kid’s swim at 4:30' },
];

export function LoopPrefs({ result }: { result: LoadLoopPrefsResult }) {
  if (result.status !== 'ready') {
    return <p className="text-spruce leading-relaxed max-w-md">{NOT_READY_NOTE[result.status]}</p>;
  }
  return <LoopForm initial={result.prefs} />;
}

function LoopForm({ initial }: { initial: LoopPrefsView }) {
  const [prefs, setPrefs] = useState<LoopPrefsView>(initial);
  const [note, setNote] = useState<string | null>(null);

  async function save(update: LoopPrefUpdate) {
    const previous = prefs;
    // Times round-trip as 'HH:MM:SS'; the input emits 'HH:MM'.
    const optimistic =
      typeof update.value === 'string' && update.value.length === 5
        ? `${update.value}:00`
        : update.value;
    setPrefs((current) => ({ ...current, [update.field]: optimistic }));
    setNote(null);
    const outcome = await setLoopPrefAction(update);
    if (outcome.status !== 'updated') {
      setPrefs(previous);
      setNote(
        outcome.status === 'not_found'
          ? 'Finish setting up your family, then you can tune your loop.'
          : "Couldn't save that just now — please try again.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-y-8">
      {/* Exchange channel */}
      <div className="flex flex-col gap-y-2">
        <span className="font-medium text-spruce">How your loop reaches you</span>
        <p className="meta">The two-way channel for replying to adjust. Push also lands in the app.</p>
        <div className="field-group mt-1" role="radiogroup" aria-label="Loop channel">
          {(['email', 'sms'] as LoopChannel[]).map((channel) => {
            const smsLocked = channel === 'sms';
            const on = prefs.loopChannel === channel;
            return (
              <label
                key={channel}
                className={`flex items-center gap-x-3 ${smsLocked ? 'opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name="loop-channel"
                  checked={on}
                  disabled={smsLocked}
                  onChange={() => save({ field: 'loopChannel', value: channel })}
                />
                <span className="text-spruce">{channel === 'email' ? 'Email' : 'Text'}</span>
                {smsLocked ? (
                  <span className="meta">Text arrives when SMS launches</span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>

      {/* Category enables */}
      <div className="flex flex-col gap-y-2">
        <span className="font-medium text-spruce">What Hale sends</span>
        <ul className="flex flex-col divide-y divide-rule border-y border-rule">
          {CATEGORY_ROWS.map((row) => {
            const on = prefs[row.field];
            return (
              <li key={row.field} className="flex items-center justify-between gap-x-6 py-4">
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
                  onClick={() => save({ field: row.field, value: !on })}
                >
                  <span className="toggle-switch-knob" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Quiet hours */}
      <div className="flex flex-col gap-y-3">
        <div>
          <span className="font-medium text-spruce">Quiet hours</span>
          <p className="meta mt-0.5">
            Normal messages wait until the window ends, in your timezone.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="field-group">
            <span className="meta">From</span>
            <input
              type="time"
              className="field"
              value={prefs.quietHoursStart.slice(0, 5)}
              onChange={(e) => save({ field: 'quietHoursStart', value: e.target.value })}
            />
          </label>
          <label className="field-group">
            <span className="meta">Until</span>
            <input
              type="time"
              className="field"
              value={prefs.quietHoursEnd.slice(0, 5)}
              onChange={(e) => save({ field: 'quietHoursEnd', value: e.target.value })}
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-x-6 pt-1">
          <div className="min-w-0">
            <span className="font-medium text-spruce">Urgent reminders may arrive during quiet hours</span>
            <p className="meta mt-0.5">Time-sensitive things only — a T-1h reminder or a safety alert.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={prefs.urgentBypassQuietHours}
            aria-label="Urgent reminders may arrive during quiet hours"
            className="toggle-switch"
            onClick={() =>
              save({ field: 'urgentBypassQuietHours', value: !prefs.urgentBypassQuietHours })
            }
          >
            <span className="toggle-switch-knob" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Weekly plan send time */}
      <div className="flex flex-col gap-y-2">
        <span className="font-medium text-spruce">Weekly plan arrives</span>
        <p className="meta">The evening before your week starts, at this time.</p>
        <label className="field-group mt-1">
          <span className="meta">Time</span>
          <input
            type="time"
            className="field"
            value={prefs.weeklyPlanSendTime.slice(0, 5)}
            onChange={(e) => save({ field: 'weeklyPlanSendTime', value: e.target.value })}
          />
        </label>
      </div>

      {/* Child-name privacy */}
      <div className="flex flex-col gap-y-2">
        <span className="font-medium text-spruce">How Hale names your child</span>
        <p className="meta">
          What a message may say. Teens (13+) are always kept generic, whatever you pick.
        </p>
        <div className="field-group mt-1" role="radiogroup" aria-label="Child-name privacy">
          {NAME_LEVELS.map((level) => (
            <label key={level.value} className="flex items-center gap-x-3">
              <input
                type="radio"
                name="child-name-level"
                checked={prefs.childNameLevel === level.value}
                onChange={() => save({ field: 'childNameLevel', value: level.value })}
              />
              <span className="text-spruce">{level.label}</span>
            </label>
          ))}
        </div>
        <p className="meta mt-1 italic">
          Preview: {NAME_LEVELS.find((l) => l.value === prefs.childNameLevel)?.preview}
        </p>
      </div>

      {note ? (
        <p className="meta text-berry" role="alert">
          {note}
        </p>
      ) : null}
    </div>
  );
}
