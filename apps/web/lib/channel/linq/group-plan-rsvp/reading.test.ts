import { describe, expect, it } from 'vitest';
import { groupPlanRsvpUserMessage, readingFromTapback, tapbackToVote } from './reading';

describe('tapbackToVote', () => {
  it('maps heart, thumbs-up, and emphasize to yes — protocol, not wording', () => {
    expect(tapbackToVote('love')).toBe('yes');
    expect(tapbackToVote('like')).toBe('yes');
    expect(tapbackToVote('emphasize')).toBe('yes');
  });

  it('maps thumbs-down to no, and leaves laugh or a question as not a vote', () => {
    expect(tapbackToVote('dislike')).toBe('no');
    expect(tapbackToVote('laugh')).toBeNull();
    expect(tapbackToVote('question')).toBeNull();
    expect(tapbackToVote(null)).toBeNull();
  });
});

describe('readingFromTapback', () => {
  it('is a high-confidence rsvp for a yes tapback, one head', () => {
    expect(readingFromTapback('like', 'Sam')).toEqual({
      intent: 'rsvp',
      planTitle: null,
      startsAt: null,
      location: null,
      deadline: null,
      response: 'yes',
      headcount: 1,
      householdLabel: null,
      coversNames: [],
      confidence: 'high',
    });
  });

  it('does not invent a vote from a laugh', () => {
    expect(readingFromTapback('laugh', 'Sam')).toBeNull();
  });
});

describe('groupPlanRsvpUserMessage', () => {
  it('hands the skill the text, tapback, and live plan facts — no reply words', () => {
    const payload = JSON.parse(
      groupPlanRsvpUserMessage({
        text: 'count the Chens in for Saturday',
        tapback: null,
        senderName: 'Maya',
        plan: {
          title: 'museum Saturday',
          deadline: 'Friday',
          yesNames: ['Priya'],
          waitingNames: ['Sam'],
        },
        recent: [{ from: 'member', text: 'museum Saturday?' }],
      }),
    ) as { text: string; plan: { title: string } };
    expect(payload.text).toBe('count the Chens in for Saturday');
    expect(payload.plan.title).toBe('museum Saturday');
    expect(JSON.stringify(payload)).not.toMatch(/reply yes|RSVP|poll/i);
  });
});
