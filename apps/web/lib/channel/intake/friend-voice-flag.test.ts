import { describe, expect, it } from 'vitest';
import {
  FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV,
  friendVoiceLeftoverMarksEnabled,
} from './friend-voice-flag';

describe('friendVoiceLeftoverMarksEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: 'true' }),
    ).toBe(true);
  });

  it('stays off for every other value, including a trailing newline and unset', () => {
    expect(friendVoiceLeftoverMarksEnabled({})).toBe(false);
    expect(friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: '' })).toBe(
      false,
    );
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: 'true\n' }),
    ).toBe(false);
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: 'TRUE' }),
    ).toBe(false);
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: '1' }),
    ).toBe(false);
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: 'on' }),
    ).toBe(false);
    expect(
      friendVoiceLeftoverMarksEnabled({ [FRIEND_VOICE_LEFTOVER_MARKS_ENABLED_ENV]: 'false' }),
    ).toBe(false);
  });
});
