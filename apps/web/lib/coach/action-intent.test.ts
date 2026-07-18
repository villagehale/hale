import { describe, expect, it } from 'vitest';
import { detectActionIntents, detectInputIntents } from './action-intent';

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

/**
 * Input-side detection: the parent's INSTRUCTION (not Hale's answer) implies a
 * command. The same closed-set, regex-only discipline as detectActionIntents —
 * no LLM on the hot path (rule #2 untouched). Hale-acts kinds (book/remind/find)
 * carry an actionType and route through the approval engine (rule #4); quick_log
 * is the parent's OWN data — no approval gate, best-effort parsed sub-shape. These
 * assert phrasing→kind from the spec, and [] for an ordinary question.
 */
describe('detectInputIntents', () => {
  it('detects a book-a-check-up instruction from imperative phrasing', () => {
    const [intent, ...rest] = detectInputIntents('book a check-up for Mira next week');
    expect(rest).toEqual([]);
    expect(intent?.category).toBe('action');
    expect(intent?.kind).toBe('book_checkup');
    if (intent?.category === 'action') expect(intent.actionType).toBe('create_calendar_event');
  });

  it('detects a set-reminder instruction', () => {
    const kinds = detectInputIntents('remind me to give the vitamin drops tonight').map(
      (i) => i.kind,
    );
    expect(kinds).toContain('set_reminder');
  });

  it('detects a find-activities instruction', () => {
    const kinds = detectInputIntents('find activities for the twins this weekend').map(
      (i) => i.kind,
    );
    expect(kinds).toContain('find_activities');
  });

  it('detects a quick_log feed with a parsed time', () => {
    const intent = detectInputIntents('Noah had a bottle at 3pm')[0];
    expect(intent?.category).toBe('log');
    expect(intent?.kind).toBe('quick_log');
    if (intent?.category === 'log') {
      expect(intent.parsed.episode).toBe('feed');
      expect(intent.parsed.timeHint).toBe('3pm');
      expect(intent.parsed.childName).toBe('Noah');
    }
  });

  it('detects a quick_log nap', () => {
    const intent = detectInputIntents('she took a nap this afternoon')[0];
    expect(intent?.category).toBe('log');
    if (intent?.category === 'log') expect(intent.parsed.episode).toBe('nap');
  });

  it('detects a quick_log milestone with the milestone text', () => {
    const intent = detectInputIntents('Ava hit a milestone: first steps today')[0];
    expect(intent?.category).toBe('log');
    if (intent?.category === 'log') {
      expect(intent.parsed.episode).toBe('milestone');
      expect(intent.parsed.milestone).toBe('first steps today');
    }
  });

  it('detects a quick_log diaper from a diaper mention', () => {
    const intent = detectInputIntents('changed a dirty diaper for Mira')[0];
    expect(intent?.category).toBe('log');
    if (intent?.category === 'log') expect(intent.parsed.episode).toBe('diaper');
  });

  it('detects a quick_log diaper from a poop / soiled mention with no "diaper" word', () => {
    const intent = detectInputIntents('she pooped after lunch')[0];
    expect(intent?.category).toBe('log');
    if (intent?.category === 'log') expect(intent.parsed.episode).toBe('diaper');
  });

  it('feed still wins when a message reads as both a feed and a diaper', () => {
    // Episode order is feed → nap → diaper → milestone; the first match wins.
    const intent = detectInputIntents('had a bottle then a wet diaper')[0];
    expect(intent?.category).toBe('log');
    if (intent?.category === 'log') expect(intent.parsed.episode).toBe('feed');
  });

  it('returns [] for an ordinary question with no instruction', () => {
    expect(detectInputIntents('is it normal for a toddler to skip a nap?')).toEqual([]);
    expect(detectInputIntents('how much should a 6-month-old eat?')).toEqual([]);
  });

  it('detects a create_plan instruction and parses its title + child', () => {
    const intent = detectInputIntents('create a plan for swimming lessons for Mira')[0];
    expect(intent?.category).toBe('plan');
    expect(intent?.kind).toBe('create_plan');
    if (intent?.category === 'plan') {
      expect(intent.parsed.title).toBe('swimming lessons');
      expect(intent.parsed.childName).toBe('Mira');
    }
  });

  it('detects a "plan … for <child>" instruction', () => {
    const intent = detectInputIntents('plan a picnic for Noah on Saturday')[0];
    expect(intent?.category).toBe('plan');
    if (intent?.category === 'plan') {
      expect(intent.parsed.title).toBe('a picnic on Saturday');
      expect(intent.parsed.childName).toBe('Noah');
    }
  });

  it('detects an "add a plan" instruction with no parsed detail', () => {
    const intent = detectInputIntents('add a plan')[0];
    expect(intent?.category).toBe('plan');
    if (intent?.category === 'plan') {
      expect(intent.parsed.title).toBeUndefined();
      expect(intent.parsed.childName).toBeUndefined();
    }
  });

  it('does not create_plan for an add_to_plan (pin-to-routine) instruction', () => {
    // "add this to our week plan" pins Hale's suggestion to the routine (approval
    // engine) — it is NOT the parent authoring a private plan from scratch.
    const kinds = detectInputIntents('add this to our week plan and pin it to the routine').map(
      (i) => i.kind,
    );
    expect(kinds).not.toContain('create_plan');
  });

  it('returns [] for an ordinary question that merely mentions a plan', () => {
    // "what's your plan" reads as conversation, not a create-plan command.
    expect(detectInputIntents('what should the plan be for teething this week?')).toEqual([]);
  });

  it('dedups: one instruction surfaces each kind at most once', () => {
    const logs = detectInputIntents('log a feed — he had a feed earlier').filter(
      (i) => i.kind === 'quick_log',
    );
    expect(logs).toHaveLength(1);
  });
});
