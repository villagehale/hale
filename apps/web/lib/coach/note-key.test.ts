import { describe, expect, it } from 'vitest';
import {
  CHANNEL_SMS_THREAD_TITLE,
  NOTE_KEY_RE,
  channelSmsNoteKey,
  isChannelSmsNoteKey,
} from './note-key';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('channelSmsNoteKey', () => {
  it('anchors one thread per parent', () => {
    expect(channelSmsNoteKey(USER_ID)).toBe(`channel-sms:${USER_ID}`);
    expect(channelSmsNoteKey(USER_ID)).toBe(channelSmsNoteKey(USER_ID));
  });

  it('gives two parents two threads', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(channelSmsNoteKey(USER_ID)).not.toBe(channelSmsNoteKey(other));
  });

  it('recognises its own keys and nothing else', () => {
    expect(isChannelSmsNoteKey(channelSmsNoteKey(USER_ID))).toBe(true);
    expect(isChannelSmsNoteKey(`digest-${USER_ID}`)).toBe(false);
    expect(isChannelSmsNoteKey(null)).toBe(false);
    expect(isChannelSmsNoteKey('channel-sms')).toBe(false);
    expect(isChannelSmsNoteKey('')).toBe(false);
  });

  /**
   * The SMS thread is written by the router alone. NOTE_KEY_RE is the bound the coach
   * API puts on a CLIENT-supplied noteKey, so a channel key failing it is the property
   * that stops a browser from posting turns into a parent's text thread.
   */
  it('is not a key any client could post', () => {
    expect(NOTE_KEY_RE.test(channelSmsNoteKey(USER_ID))).toBe(false);
  });

  it('names the thread the way the app shows it', () => {
    expect(CHANNEL_SMS_THREAD_TITLE).toBe('Texts with Hale');
  });
});
