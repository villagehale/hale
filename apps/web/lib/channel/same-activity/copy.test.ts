import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import { readSameActivityChoice } from './choice';
import {
  deliverSameActivityReply,
  renderSameActivityReply,
  sameActivityCopyMayLeave,
} from './copy';
import {
  SAME_ACTIVITY_ASK_NEXT,
  SAME_ACTIVITY_DECLINE_NEXT,
  SAME_ACTIVITY_MUTUAL_NEXT,
  SAME_ACTIVITY_PLACEHOLDER_COPY,
  SAME_ACTIVITY_WAITING_NEXT,
} from './placeholders';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const BANNED = /\bSTOP\b|unsubscribe/i;

describe('same-activity copy', () => {
  it('keeps every parent-facing line a design placeholder with one next step', () => {
    const nextSteps = [
      SAME_ACTIVITY_ASK_NEXT,
      SAME_ACTIVITY_WAITING_NEXT,
      SAME_ACTIVITY_MUTUAL_NEXT,
      SAME_ACTIVITY_DECLINE_NEXT,
    ];
    for (const line of SAME_ACTIVITY_PLACEHOLDER_COPY) {
      expect(line.startsWith('TODO-Design:')).toBe(true);
      expect(line).not.toMatch(BANNED);
      expect(line).not.toContain(OPT_OUT_LINE);
      expect(line).not.toContain(OPT_OUT_SHORT);
      expect(line).not.toMatch(/\d/);
      expect(line.includes('\n')).toBe(false);
      const say = line.split(/(?<=\.)\s+/u).filter((part) => part.startsWith('Say '));
      expect(say).toHaveLength(1);
      expect(line.endsWith(say[0] ?? '')).toBe(true);
      expect(nextSteps).toContain(say[0]);
      expect(sameActivityCopyMayLeave(line)).toBe(false);
    }
  });

  it('does not let a finished-looking sentence leave, and does not send', () => {
    expect(
      sameActivityCopyMayLeave('Both households said yes. Say what you want to do next.'),
    ).toBe(false);
    const reply = renderSameActivityReply('mutual', 'meet');
    expect(reply.mayLeave).toBe(false);
    expect(reply.text.endsWith(reply.nextStep)).toBe(true);
    expect(deliverSameActivityReply(reply.text)).toEqual({ sent: false, skipped: 'placeholder' });
    expect(renderSameActivityReply('mutual', 'join_group').text).not.toBe(reply.text);
    expect(
      renderSameActivityReply('waiting', 'meet').text.endsWith(SAME_ACTIVITY_WAITING_NEXT),
    ).toBe(true);
    expect(
      renderSameActivityReply('declined', null).text.endsWith(SAME_ACTIVITY_DECLINE_NEXT),
    ).toBe(true);
  });

  it('reads only a whole-message meet, join, or no', () => {
    expect(readSameActivityChoice('Meet.')).toBe('meet');
    expect(readSameActivityChoice(' JOIN ')).toBe('join_group');
    expect(readSameActivityChoice('no')).toBe('no');
    for (const body of ['STOP', 'stop', 'meet please', 'join the group', 'yes', '']) {
      expect(readSameActivityChoice(body)).toBeNull();
    }
  });

  it('does not wire a send, and does not read who signed up', () => {
    const files = readdirSync(DIR).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toContain('offer.ts');
    expect(files).toContain('store.ts');
    for (const name of files) {
      const source = readFileSync(`${DIR}${name}`, 'utf8');
      expect(source, name).not.toMatch(
        /twilio|sendSms|withOptOut|activity_bookings|activityBookings/,
      );
      expect(source, name).not.toMatch(/schema\.children|schema\.families/);
    }
  });
});
