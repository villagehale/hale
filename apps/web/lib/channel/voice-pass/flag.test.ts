import { afterEach, describe, expect, it } from 'vitest';
import { VOICE_PASS_LANES_ENV, voicePassEnabledFor } from './flag';

const original = process.env[VOICE_PASS_LANES_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[VOICE_PASS_LANES_ENV];
  else process.env[VOICE_PASS_LANES_ENV] = original;
});

function set(value: string | undefined): void {
  if (value === undefined) delete process.env[VOICE_PASS_LANES_ENV];
  else process.env[VOICE_PASS_LANES_ENV] = value;
}

describe('voicePassEnabledFor', () => {
  it('is off for every lane when the variable is unset', () => {
    set(undefined);
    expect(voicePassEnabledFor('email_alert')).toBe(false);
    expect(voicePassEnabledFor('calendar_alert')).toBe(false);
  });

  it('is off for every lane when the variable is empty', () => {
    set('');
    expect(voicePassEnabledFor('email_alert')).toBe(false);
    expect(voicePassEnabledFor('calendar_alert')).toBe(false);
  });

  it('arms only the lanes it names', () => {
    set('email_alert');
    expect(voicePassEnabledFor('email_alert')).toBe(true);
    expect(voicePassEnabledFor('calendar_alert')).toBe(false);
  });

  it('arms both when both are named', () => {
    set('email_alert,calendar_alert');
    expect(voicePassEnabledFor('email_alert')).toBe(true);
    expect(voicePassEnabledFor('calendar_alert')).toBe(true);
  });

  it('survives the trailing newline `vercel env add` stores from a piped echo', () => {
    // The trap f14.ts strict comparison exists for: a value that PRINTS as `email_alert`
    // is really `'email_alert\n'`, and a membership test over untrimmed members would
    // read it as a lane nobody armed - in this direction, as a lane nobody armed being
    // silently OFF, which is how a dark flag stays dark after the founder flipped it.
    set('email_alert\n');
    expect(voicePassEnabledFor('email_alert')).toBe(true);
    set(' email_alert , calendar_alert ');
    expect(voicePassEnabledFor('email_alert')).toBe(true);
    expect(voicePassEnabledFor('calendar_alert')).toBe(true);
  });

  it('is off for a lane name it does not recognise, and for a truthy-looking value', () => {
    set('true');
    expect(voicePassEnabledFor('email_alert')).toBe(false);
    set('email_alerts');
    expect(voicePassEnabledFor('email_alert')).toBe(false);
  });
});
