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
    expect(
      picnic?.transcript.some((line) => line.kind === 'person' && line.text.includes('tapback')),
    ).toBe(true);
    expect(
      picnic?.transcript.some((line) => line.kind === 'note' && /quiet/i.test(line.text)),
    ).toBe(true);
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
    expect(soccer?.transcript.some((line) => /quiet hours/i.test(line.text))).toBe(true);
    expect(soccer?.transcript.some((line) => /deduped/i.test(line.text))).toBe(true);
    expect(
      soccer?.transcript.some((line) => line.kind === 'hale' && /soccer Saturday/.test(line.text)),
    ).toBe(true);
  });
});
