import { describe, expect, it } from 'vitest';
import { runPreviewGroupPlanConversations } from './preview-conversation';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

describe('runPreviewGroupPlanConversations', () => {
  it('plays three fake-family conversations covering the T15 bar', async () => {
    const conversations = await runPreviewGroupPlanConversations({
      composer: fakeGroupPlanRsvpComposer(),
    });
    expect(conversations.map((c) => c.id)).toEqual([
      'picnic-edits',
      'museum-family',
      'soccer-followups',
    ]);

    const picnic = conversations[0];
    expect(picnic?.people.some((p) => !p.haleCustomer)).toBe(true);
    expect(picnic?.transcript.some((line) => line.event === 'tapback')).toBe(true);
    expect(picnic?.transcript.some((line) => line.event === 'banter')).toBe(true);
    expect(picnic?.tally?.noCount).toBe(1);
    expect(picnic?.transcript.filter((line) => line.kind === 'hale').length).toBeGreaterThanOrEqual(
      2,
    );

    const museum = conversations[1];
    expect(museum?.tally?.yesHeads).toBe(3);
    expect(museum?.tally?.yesNames).toEqual(['the Chens']);
    expect(museum?.tally?.waitingNames).toContain('Sam');
    expect(museum?.tally?.waitingNames).not.toContain('Wei');

    const soccer = conversations[2];
    expect(soccer?.transcript.some((line) => line.event === 'quiet_hours')).toBe(true);
    expect(soccer?.transcript.some((line) => line.event === 'deduped')).toBe(true);
    expect(soccer?.transcript.filter((line) => line.kind === 'hale').length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
