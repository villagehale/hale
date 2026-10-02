import { describe, expect, it } from 'vitest';
import {
  MID_ACTIVITY_ACK_EN,
  MID_ACTIVITY_ACK_FR,
  MID_ACTIVITY_ASK_EN,
  MID_ACTIVITY_ASK_FR,
  MID_ACTIVITY_ASK_NO_ACTIVITY_EN,
  MID_ACTIVITY_ASK_NO_ACTIVITY_FR,
  midActivityAck,
  midActivityAsk,
  midActivityCopyMayLeave,
  replyEndsWithOneNextStep,
} from './copy';

const LOCKED = [
  MID_ACTIVITY_ASK_EN,
  MID_ACTIVITY_ASK_FR,
  MID_ACTIVITY_ASK_NO_ACTIVITY_EN,
  MID_ACTIVITY_ASK_NO_ACTIVITY_FR,
  MID_ACTIVITY_ACK_EN,
  MID_ACTIVITY_ACK_FR,
] as const;

describe('mid-activity copy', () => {
  it('keeps each locked line byte for byte, ASCII, and one next step', () => {
    expect(MID_ACTIVITY_ASK_EN).toBe(
      "How's {activity} going so far? Just a line back is plenty.",
    );
    expect(MID_ACTIVITY_ASK_FR).toBe(
      'Comment ca se passe pour {activity}? Une phrase en reponse suffit.',
    );
    expect(MID_ACTIVITY_ASK_NO_ACTIVITY_EN).toBe(
      "How's it going so far? Just a line back is plenty.",
    );
    expect(MID_ACTIVITY_ASK_NO_ACTIVITY_FR).toBe(
      "Comment ca se passe jusqu'ici? Une phrase en reponse suffit.",
    );
    expect(MID_ACTIVITY_ACK_EN).toBe(
      "Thanks, that helps. I'll use it when I pick what to send you next.",
    );
    expect(MID_ACTIVITY_ACK_FR).toBe(
      "Merci, ca m'aide. Je m'en sers pour choisir la prochaine suggestion.",
    );
    expect(midActivityAsk('swim', 'en')).toBe(
      "How's swim going so far? Just a line back is plenty.",
    );
    expect(midActivityAsk('natation', 'fr')).toBe(
      'Comment ca se passe pour natation? Une phrase en reponse suffit.',
    );
    expect(midActivityAsk('  ', 'en')).toBe(MID_ACTIVITY_ASK_NO_ACTIVITY_EN);
    expect(midActivityAsk(null, 'fr')).toBe(MID_ACTIVITY_ASK_NO_ACTIVITY_FR);
    expect(midActivityAck('en')).toBe(MID_ACTIVITY_ACK_EN);
    expect(midActivityAck('fr')).toBe(MID_ACTIVITY_ACK_FR);
    for (const line of LOCKED) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(replyEndsWithOneNextStep(line.replaceAll('{activity}', 'swim'))).toBe(true);
      expect(midActivityCopyMayLeave(line.replaceAll('{activity}', 'swim'))).toBe(true);
      expect(line).not.toMatch(/\bSTOP\b|unsubscribe|opt[- ]out/i);
    }
  });

  it('refuses a line that opts the parent out or does not end in exactly one next step', () => {
    expect(midActivityCopyMayLeave("How's swim going so far? Just a line back is plenty.")).toBe(
      true,
    );
    expect(
      midActivityCopyMayLeave(
        "How's swim going so far? Just a line back is plenty. Reply STOP to opt out.",
      ),
    ).toBe(false);
    expect(
      midActivityCopyMayLeave(
        "How's swim going so far? Just a line back is plenty. Text me again tomorrow.",
      ),
    ).toBe(false);
    expect(midActivityCopyMayLeave("How's swim going so far?")).toBe(false);
    expect(replyEndsWithOneNextStep('How is swim going? Next: one line is enough.')).toBe(true);
    expect(replyEndsWithOneNextStep('How is swim going? Next: one line. Next: another line.')).toBe(
      false,
    );
  });
});
