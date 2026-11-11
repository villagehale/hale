import { describe, expect, it } from 'vitest';
import { dryClient, parseEventNotesFlags } from './event-notes-flags.mjs';

describe('parseEventNotesFlags', () => {
  it.each(['dry', 'broken', 'cached-only', 'live'])('accepts --%s alone', (mode) => {
    expect(parseEventNotesFlags([`--${mode}`])).toBe(mode);
  });
  it('refuses no mode, two modes, and unknown flags', () => {
    expect(() => parseEventNotesFlags([])).toThrow(/exactly one/);
    expect(() => parseEventNotesFlags(['--dry', '--live'])).toThrow(/exactly one/);
    expect(() => parseEventNotesFlags(['--dyr'])).toThrow(/unknown/);
    expect(() => parseEventNotesFlags(['--dry', '--preflight'])).toThrow(/unknown/);
  });
  it('the stub client always throws', () => {
    expect(() => dryClient()).toThrow(/outside --live/);
  });
});
