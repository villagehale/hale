import { describe, expect, it } from 'vitest';
import { actionTypeLabel, spokenActionLabel, verdictLabel, villageKindLabel } from './labels.js';

/**
 * The label layer's contract (the HARD rule): a stored token is NEVER rendered
 * raw. Every mapper either returns curated human copy or a neutral fallback — it
 * never de-underscores the token as a fallback, and `villageKindLabel` hides
 * (returns null) rather than surface an internal/unknown category.
 */

describe('villageKindLabel', () => {
  it('maps each discovery category to human copy (spaces, not underscores)', () => {
    // Source of truth: apps/worker/prompts/discovery.md category enum.
    expect(villageKindLabel('drop_in')).toBe('drop-in');
    expect(villageKindLabel('community_event')).toBe('community event');
    expect(villageKindLabel('class')).toBe('class');
    expect(villageKindLabel('program')).toBe('program');
    expect(villageKindLabel('outdoor')).toBe('outdoors');
    expect(villageKindLabel('library')).toBe('library');
  });

  it('hides the eyebrow for the generic internal kind and the catch-all category', () => {
    // `activity` is the constant stamped on every discovered candidate — not a
    // meaningful human category; `other` is the discovery catch-all. Both hide.
    expect(villageKindLabel('activity')).toBeNull();
    expect(villageKindLabel('other')).toBeNull();
  });

  it('hides (null) for null and for an unknown/internal token — never de-underscores', () => {
    expect(villageKindLabel(null)).toBeNull();
    // A token we do not curate must NOT leak as "support group"; it hides.
    expect(villageKindLabel('support_group')).toBeNull();
    expect(villageKindLabel('sibling_calendar_overlap')).toBeNull();
  });
});

/**
 * The SPOKEN half (docs/voice.md rule 4). The Record above is a web UI table column and
 * is authored Title Case for that; the router splices it into a text, where lowercasing a
 * UI label leaves a headless noun phrase — "Approved - note in your digest." reads as a
 * form field. These four are the ones that read that way.
 */
describe('spokenActionLabel', () => {
  it('gives the four UI-flavoured labels a phrase that reads in both router frames', () => {
    // Derived from the two call sites, not from the function's output: the same string
    // has to survive "Approved - X." and "Dropped it - X won't happen."
    for (const [type, spoken] of [
      ['add_to_digest_only', 'the note in your digest'],
      ['add_to_routine', 'the pin on your routine'],
      ['calendar_move', 'the move on your calendar'],
      ['calendar_cancel', 'the cancellation on your calendar'],
    ] as const) {
      expect(spokenActionLabel(type)).toBe(spoken);
      expect(`Dropped it - ${spoken} won't happen.`).toMatch(/^Dropped it - the \w/);
    }
  });

  it('falls through to the lowercased label for every type that already reads as English', () => {
    expect(spokenActionLabel('create_calendar_event')).toBe('add to calendar');
    expect(spokenActionLabel('send_email')).toBe('send email');
    expect(spokenActionLabel('some_new_action')).toBe('an action');
  });

  it('never hands a text a Title Case fragment', () => {
    // Every action type the product has, including the unknown fallback: none of them may
    // arrive mid-sentence with a capital on the first word.
    const types = [
      'send_email',
      'reply_to_email',
      'create_calendar_event',
      'update_calendar_event',
      'place_supply_order',
      'cancel_supply_order',
      'fill_pdf_form',
      'submit_government_form',
      'book_clinic_portal',
      'cancel_clinic_appointment',
      'share_photos_with_family',
      'add_to_digest_only',
      'add_to_routine',
      'calendar_add',
      'calendar_move',
      'calendar_cancel',
      'some_new_action',
    ];
    for (const type of types) {
      expect(spokenActionLabel(type), type).toMatch(/^[a-z]/);
    }
    // The positive control: the UI Record really is Title Case, so this test is measuring
    // a difference rather than passing on a table that was never capitalised.
    expect(actionTypeLabel('add_to_digest_only')).toMatch(/^[A-Z]/);
  });
});

describe('actionTypeLabel', () => {
  it('maps each action type to a human verb phrase', () => {
    // Source of truth: packages/types/src/action.ts ActionType.
    expect(actionTypeLabel('send_email')).toBe('Send email');
    expect(actionTypeLabel('reply_to_email')).toBe('Reply to email');
    expect(actionTypeLabel('create_calendar_event')).toBe('Add to calendar');
    expect(actionTypeLabel('update_calendar_event')).toBe('Update calendar');
    expect(actionTypeLabel('place_supply_order')).toBe('Order supplies');
    expect(actionTypeLabel('cancel_supply_order')).toBe('Cancel supply order');
    expect(actionTypeLabel('fill_pdf_form')).toBe('Fill a form');
    expect(actionTypeLabel('submit_government_form')).toBe('Submit a government form');
    expect(actionTypeLabel('book_clinic_portal')).toBe('Book a clinic appointment');
    expect(actionTypeLabel('cancel_clinic_appointment')).toBe('Cancel a clinic appointment');
    expect(actionTypeLabel('share_photos_with_family')).toBe('Share photos with family');
    expect(actionTypeLabel('add_to_digest_only')).toBe('Note in your digest');
    expect(actionTypeLabel('add_to_routine')).toBe('Pin to your routine');
  });

  it('falls back to neutral copy for an unknown token — never de-underscores', () => {
    expect(actionTypeLabel('some_new_action')).toBe('an action');
    expect(actionTypeLabel('')).toBe('an action');
  });
});

describe('verdictLabel', () => {
  it('maps each reviewer verdict to human copy', () => {
    // Source of truth: packages/db/src/schema/enums.ts reviewer_verdict.
    expect(verdictLabel('pending')).toBe('awaiting review');
    expect(verdictLabel('approved')).toBe('verified by the reviewer');
    expect(verdictLabel('rejected')).toBe('the reviewer raised a concern');
    expect(verdictLabel('flagged')).toBe('flagged for your review');
    expect(verdictLabel('superseded')).toBe('replaced by a newer draft');
  });

  it('falls back to neutral copy for an unknown token — never de-underscores', () => {
    expect(verdictLabel('some_new_verdict')).toBe('awaiting your approval');
    expect(verdictLabel('')).toBe('awaiting your approval');
  });
});

describe('village attribute chips — unknown tokens stay hidden (honesty)', () => {
  it('resolves an unknown price band to null, never the raw token', async () => {
    const { priceBandLabel } = await import('./labels');
    expect(priceBandLabel('cheap-ish')).toBeNull();
    expect(priceBandLabel(null)).toBeNull();
    expect(priceBandLabel('free')).toBe('free');
  });

  it('resolves an unknown indoor/outdoor value to null, never the raw token', async () => {
    const { indoorOutdoorLabel } = await import('./labels');
    expect(indoorOutdoorLabel('mixed')).toBeNull();
    expect(indoorOutdoorLabel(null)).toBeNull();
    expect(indoorOutdoorLabel('both')).toBe('indoor & outdoor');
  });
});
