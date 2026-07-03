import { describe, expect, it } from 'vitest';
import { actionTypeLabel, verdictLabel, villageKindLabel } from './labels.js';

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
