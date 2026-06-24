import { describe, expect, it } from 'vitest';
import { detectActionIntents } from './action-intent';

/**
 * The inline-action thesis: when an answer IMPLIES a real Hale action, the UI
 * offers a gated chip — it never auto-acts (rule #4). Detection is a small, closed
 * set of intents matched from the answer text; each maps to a known ActionType the
 * existing approval engine can draft. These assert the mapping (derived from the
 * intent spec, not the code's output) and that an ordinary answer yields NO chips
 * (no false action surface).
 */

describe('detectActionIntents', () => {
  it('surfaces a "find activities" chip when the answer points to local activities', () => {
    const intents = detectActionIntents(
      "there are some great toddler music classes near you — want me to find activities you could try?",
    );
    expect(intents.map((i) => i.kind)).toContain('find_activities');
    const found = intents.find((i) => i.kind === 'find_activities');
    expect(found?.actionType).toBe('add_to_digest_only');
  });

  it('surfaces an "add to week plan" chip when the answer suggests pinning to the routine', () => {
    const intents = detectActionIntents(
      'you could add this to your week plan so it becomes part of the routine.',
    );
    const plan = intents.find((i) => i.kind === 'add_to_plan');
    expect(plan).toBeDefined();
    expect(plan?.actionType).toBe('add_to_routine');
  });

  it('surfaces a "book a check-up" chip for a health/appointment suggestion', () => {
    const intents = detectActionIntents(
      'it would be worth booking a check-up with your pediatrician to confirm.',
    );
    const book = intents.find((i) => i.kind === 'book_checkup');
    expect(book).toBeDefined();
    expect(book?.actionType).toBe('create_calendar_event');
  });

  it('returns no chips for an ordinary answer with no implied action', () => {
    const intents = detectActionIntents(
      'that much spit-up is very common at this age and usually settles on its own.',
    );
    expect(intents).toEqual([]);
  });

  it('dedups: a single answer surfaces each intent at most once', () => {
    const intents = detectActionIntents(
      'find activities near you — there are lots of activities to find!',
    );
    expect(intents.filter((i) => i.kind === 'find_activities')).toHaveLength(1);
  });
});
