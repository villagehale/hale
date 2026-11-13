import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inviteLinkHash } from './calendar-invite-link-hash';

const EVENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('inviteLinkHash', () => {
  it('is sha256 hex of ics-link:<event id>, and not the url', () => {
    const expected = createHash('sha256').update(`ics-link:${EVENT_ID}`).digest('hex');
    expect(inviteLinkHash(EVENT_ID)).toBe(expected);
    expect(inviteLinkHash(EVENT_ID)).not.toContain(EVENT_ID);
    expect(inviteLinkHash(EVENT_ID)).not.toBe(
      inviteLinkHash('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    );
  });
});
