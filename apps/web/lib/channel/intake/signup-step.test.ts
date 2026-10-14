import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignupStepReader, openSignupStep, toSignupStepReading } from './signup-step';

describe('openSignupStep', () => {
  it('waits on names, then the offer, then calendar, then email', () => {
    expect(openSignupStep({ signupAsked: false, calendarAsked: false, emailAsked: false })).toBe(
      'names',
    );
    expect(openSignupStep({ signupAsked: true, calendarAsked: false, emailAsked: false })).toBe(
      'signup',
    );
    expect(openSignupStep({ signupAsked: true, calendarAsked: true, emailAsked: false })).toBe(
      'calendar',
    );
    expect(openSignupStep({ signupAsked: true, calendarAsked: true, emailAsked: true })).toBe(
      'email',
    );
  });
});

describe('toSignupStepReading', () => {
  it('keeps a boolean and drops anything else', () => {
    expect(toSignupStepReading({ answers: true })).toEqual({ answers: true });
    expect(toSignupStepReading({ answers: false })).toEqual({ answers: false });
    expect(toSignupStepReading({ answers: 'false' })).toBeNull();
    expect(toSignupStepReading({})).toBeNull();
  });
});

describe('createSignupStepReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a missing client and does not log the parent text', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = createSignupStepReader(() => {
      throw new Error('no key');
    });
    await expect(reader.read({ step: 'names', text: '你好，周末有什么' })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('你好');
  });
});
