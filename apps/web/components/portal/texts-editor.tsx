'use client';

import { useState } from 'react';
import {
  CHILD_NAME_GENERIC,
  CHILD_NAME_RELATION,
  type ChildNameLevel,
  type LoopPrefsView,
} from '~/lib/loop/prefs';
import { setLoopPrefAction } from '~/lib/settings/loop-prefs-actions';
import { clockLabel } from './format';
import styles from './portal.module.css';

const LEVELS: { value: ChildNameLevel; label: string }[] = [
  { value: 'first_name', label: 'First name' },
  { value: 'relation', label: 'Daughter, son' },
  { value: 'generic', label: 'Your kid' },
];

export function TextsEditor({
  prefs,
  childFirstName,
}: {
  prefs: LoopPrefsView;
  childFirstName: string | null;
}) {
  const [view, setView] = useState(prefs);
  const [editingQuiet, setEditingQuiet] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function save<
    K extends
      | 'catWeeklyPlan'
      | 'catReminder'
      | 'catApproval'
      | 'catAlert'
      | 'urgentBypassQuietHours',
  >(field: K, value: boolean) {
    const previous = view[field];
    setView({ ...view, [field]: value });
    setNote(null);
    const outcome = await setLoopPrefAction({ field, value });
    if (outcome.status !== 'updated') {
      setView({ ...view, [field]: previous });
      setNote('couldn’t save just now — please try again.');
    }
  }

  async function saveQuiet(field: 'quietHoursStart' | 'quietHoursEnd', value: string) {
    const previous = view[field];
    const stored = value.length === 5 ? `${value}:00` : value;
    setView({ ...view, [field]: stored });
    setNote(null);
    const outcome = await setLoopPrefAction({ field, value });
    if (outcome.status !== 'updated') {
      setView({ ...view, [field]: previous });
      setNote('couldn’t save just now — please try again.');
    }
  }

  async function saveLevel(value: ChildNameLevel) {
    const previous = view.childNameLevel;
    setView({ ...view, childNameLevel: value });
    setNote(null);
    const outcome = await setLoopPrefAction({ field: 'childNameLevel', value });
    if (outcome.status !== 'updated') {
      setView({ ...view, childNameLevel: previous });
      setNote('couldn’t save just now — please try again.');
    }
  }

  const preview =
    view.childNameLevel === 'first_name'
      ? childFirstName
      : view.childNameLevel === 'relation'
        ? `${CHILD_NAME_RELATION.girl} · ${CHILD_NAME_RELATION.boy}`
        : CHILD_NAME_GENERIC;

  return (
    <div className={styles.one}>
      <section className={`${styles.card} ${styles.span}`}>
        <span className={styles.tag}>What Hale sends</span>
        <Toggle
          title="Weekly plan"
          meta="Your look-ahead, Sunday at 6 PM."
          on={view.catWeeklyPlan}
          onToggle={() => save('catWeeklyPlan', !view.catWeeklyPlan)}
        />
        <Toggle
          title="Reminders"
          meta="Nudges before the things that matter."
          on={view.catReminder}
          onToggle={() => save('catReminder', !view.catReminder)}
        />
        <Toggle
          title="Questions for you"
          meta="When Hale needs your yes first."
          on={view.catApproval}
          onToggle={() => save('catApproval', !view.catApproval)}
        />
        <Toggle
          title="Alerts"
          meta="The few things worth a text right away."
          on={view.catAlert}
          onToggle={() => save('catAlert', !view.catAlert)}
        />
      </section>
      <section className={`${styles.card} ${styles.span}`}>
        <span className={styles.tag}>Quiet hours</span>
        <div className={`${styles.row} ${styles.tight}`}>
          <span>
            <h3>
              {clockLabel(view.quietHoursStart)} to {clockLabel(view.quietHoursEnd)}
            </h3>
            <p className={styles.meta}>Hale holds texts until morning.</p>
            {editingQuiet ? (
              <div className={styles.quietEdit}>
                <label>
                  From
                  <input
                    type="time"
                    value={view.quietHoursStart.slice(0, 5)}
                    onChange={(event) => saveQuiet('quietHoursStart', event.currentTarget.value)}
                  />
                </label>
                <label>
                  Until
                  <input
                    type="time"
                    value={view.quietHoursEnd.slice(0, 5)}
                    onChange={(event) => saveQuiet('quietHoursEnd', event.currentTarget.value)}
                  />
                </label>
              </div>
            ) : null}
          </span>
          <span className={styles.end}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setEditingQuiet((open) => !open)}
            >
              Change
            </button>
          </span>
        </div>
        <Toggle
          title="Let urgent ones through"
          meta="A reminder an hour before, or a safety alert."
          on={view.urgentBypassQuietHours}
          onToggle={() => save('urgentBypassQuietHours', !view.urgentBypassQuietHours)}
        />
      </section>
      <section className={`${styles.card} ${styles.span}`}>
        <span className={styles.tag}>How Hale names your kids</span>
        <div className={styles.seg} role="tablist" aria-label="How Hale names your kids">
          {LEVELS.map((level) => (
            <button
              key={level.value}
              type="button"
              role="tab"
              aria-selected={view.childNameLevel === level.value}
              className={view.childNameLevel === level.value ? styles.segOn : undefined}
              onClick={() => saveLevel(level.value)}
            >
              {level.label}
            </button>
          ))}
        </div>
        {preview ? (
          <div className={styles.preview}>
            <p className={styles.previewLabel}>Preview</p>
            <div className={`${styles.bubble} ${styles.in}`} data-hale-pii>
              {preview}
            </div>
          </div>
        ) : null}
      </section>
      {note ? (
        <p className={styles.note} role="alert">
          {note}
        </p>
      ) : null}
      <p className={`${styles.text} ${styles.span}`}>
        To pause all texts, reply STOP to Hale. Reply START to turn them back on.
      </p>
    </div>
  );
}

function Toggle({
  title,
  meta,
  on,
  onToggle,
}: {
  title: string;
  meta: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`${styles.row} ${styles.tight}`}>
      <span>
        <h3>{title}</h3>
        <p className={styles.meta}>{meta}</p>
      </span>
      <span className={styles.end}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={title}
          className={on ? `${styles.tog} ${styles.togOn}` : styles.tog}
          onClick={onToggle}
        />
      </span>
    </div>
  );
}
