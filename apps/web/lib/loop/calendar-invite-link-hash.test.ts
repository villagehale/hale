import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_INVITE_LINK_HASH_ENABLED_ENV,
  calendarInviteLinkHashEnabled,
  familyEventIdFromInviteUrl,
  inviteLinkHash,
} from './calendar-invite-link-hash';

const EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('calendarInviteLinkHashEnabled (VIL-588)', () => {
  it('is off when unset, empty, or any spelling other than exact true', () => {
    expect(calendarInviteLinkHashEnabled({})).toBe(false);
    expect(calendarInviteLinkHashEnabled({ [CALENDAR_INVITE_LINK_HASH_ENABLED_ENV]: '' })).toBe(
      false,
    );
    for (const value of ['TRUE', 'True', '1', 'on', 'yes', 'true\n', ' true', 'true ']) {
      expect(
        calendarInviteLinkHashEnabled({ [CALENDAR_INVITE_LINK_HASH_ENABLED_ENV]: value }),
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('is on only for exactly true', () => {
    expect(calendarInviteLinkHashEnabled({ [CALENDAR_INVITE_LINK_HASH_ENABLED_ENV]: 'true' })).toBe(
      true,
    );
  });
});

describe('inviteLinkHash', () => {
  it('is sha256 hex of ics-link:<event id>, and not the url', () => {
    const expected = createHash('sha256').update(`ics-link:${EVENT_ID}`).digest('hex');
    expect(inviteLinkHash(EVENT_ID)).toBe(expected);
    expect(inviteLinkHash(EVENT_ID)).toHaveLength(64);
    expect(inviteLinkHash(EVENT_ID)).not.toContain(EVENT_ID);
    expect(inviteLinkHash(EVENT_ID)).not.toBe(
      inviteLinkHash('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    );
  });
});

describe('familyEventIdFromInviteUrl', () => {
  it('reads the uuid in a per-event ICS path, and nothing else', () => {
    expect(
      familyEventIdFromInviteUrl(`https://app.villagehale.com/api/ics/event/${EVENT_ID}.sig`),
    ).toBe(EVENT_ID);
    expect(
      familyEventIdFromInviteUrl('https://app.villagehale.com/api/ics/event/not-a-uuid.sig'),
    ).toBe(null);
    expect(familyEventIdFromInviteUrl('https://evil.example/api/ics/event')).toBe(null);
  });
});
