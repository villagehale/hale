import { describe, expect, it } from 'vitest';
import { describeScope } from './scope-copy';

describe('describeScope', () => {
  it('labels the owned-calendar read scope that a new Calendar connect asks for as read-only', () => {
    expect(describeScope('https://www.googleapis.com/auth/calendar.events.owned.readonly')).toEqual(
      {
        label: 'Calendar',
        readOnly: true,
      },
    );
  });

  it('keeps the labels for scopes that stored rows still carry', () => {
    expect(describeScope('https://www.googleapis.com/auth/calendar.readonly')).toEqual({
      label: 'Calendar',
      readOnly: true,
    });
    expect(describeScope('https://www.googleapis.com/auth/drive.readonly')).toEqual({
      label: 'Files',
      readOnly: true,
    });
  });

  it('never calls a write scope or an unknown scope read-only', () => {
    expect(describeScope('https://www.googleapis.com/auth/calendar.events').readOnly).toBe(false);
    expect(describeScope('https://example.test/unknown')).toEqual({
      label: 'https://example.test/unknown',
      readOnly: false,
    });
  });
});
