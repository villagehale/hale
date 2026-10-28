import { describe, expect, it } from 'vitest';
import { previewConversationFacts, runCarpoolPreviewConversations } from './carpool-preview';

describe('runCarpoolPreviewConversations', () => {
  const conversations = runCarpoolPreviewConversations();

  it('plays several people from three fake families, never a real number', () => {
    expect(conversations).toHaveLength(5);
    for (const conversation of conversations) {
      expect(conversation.families).toHaveLength(3);
      expect(conversation.before.some((line) => line.from === 'Hale')).toBe(false);
      const phones = JSON.stringify(conversation);
      expect(phones).not.toMatch(/\+1\d{10}/);
    }
    expect(previewConversationFacts(conversations).families).toBe(3);
  });

  it('asks once when nobody has claimed the drive, then stays quiet', () => {
    const conversation = conversations.find((item) => item.id === 'no-driver-ask-once');
    const hale = conversation?.after.filter((line) => line.from === 'Hale') ?? [];
    expect(hale).toHaveLength(1);
    expect(hale[0]?.text).toContain('ask_driver');
  });

  it('follows a mid-thread swap and reminds the new driver in the group', () => {
    const conversation = conversations.find((item) => item.id === 'driver-swap');
    const hale = conversation?.after.filter((line) => line.from === 'Hale') ?? [];
    expect(hale.length).toBeGreaterThan(0);
    expect(hale.some((line) => line.text.includes('Priya'))).toBe(true);
    expect(conversation?.notes.some((note) => note.includes('driver_not_customer'))).toBe(true);
  });

  it('holds the night-before reminder in quiet hours', () => {
    const conversation = conversations.find((item) => item.id === 'quiet-hours');
    expect(conversation?.after.some((line) => line.from === 'Hale')).toBe(false);
    expect(
      conversation?.notes.some(
        (note) => note.includes('quiet_hours') || note.includes('window_closed'),
      ),
    ).toBe(true);
  });

  it('sends nothing after the plan is cancelled', () => {
    const conversation = conversations.find((item) => item.id === 'cancelled');
    expect(conversation?.after.some((line) => line.from === 'Hale')).toBe(false);
    expect(conversation?.notes).toContain('reminder:skip:cancelled');
  });

  it('reads a tapback as the person taking the drive', () => {
    const conversation = conversations.find((item) => item.id === 'tapback-yes');
    expect(conversation?.after.some((line) => line.text.includes('tapback'))).toBe(true);
    expect(conversation?.after.filter((line) => line.from === 'Hale')).toHaveLength(1);
  });
});
