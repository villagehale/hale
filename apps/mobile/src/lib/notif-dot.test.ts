import { describe, expect, it } from 'vitest';

import { messageUnread, notifDotOn } from './notif-dot';

describe('notifDotOn — the Home bell dot rule', () => {
  it('lights when there are pending approvals, even after Mark all read', () => {
    // Pending approvals are actionable work — acknowledgement must never hide them.
    expect(notifDotOn(2, 0, true)).toBe(true);
    expect(notifDotOn(2, 0, false)).toBe(true);
  });

  it('lights for unacknowledged messages when nothing is pending', () => {
    expect(notifDotOn(0, 3, false)).toBe(true);
  });

  it('goes dark once messages are acknowledged and nothing is pending', () => {
    // "Mark all read" quiets the informational message stream.
    expect(notifDotOn(0, 3, true)).toBe(false);
  });

  it('stays dark for a family with nothing waiting (honest empty — not the Task-6 default-on)', () => {
    expect(notifDotOn(0, 0, false)).toBe(false);
    expect(notifDotOn(0, 0, true)).toBe(false);
  });
});

describe('messageUnread — the Messages-list row dot rule', () => {
  it("lights a today's note only until the session is acknowledged", () => {
    expect(messageUnread(true, false)).toBe(true);
    expect(messageUnread(true, true)).toBe(false);
  });

  it('never lights an older note — the dot follows the family-zone `today` flag, not age', () => {
    // A note stamped before today is not "unread"; there is no per-message read state
    // to invent, so only today's unacknowledged notes carry a dot (data honesty).
    expect(messageUnread(false, false)).toBe(false);
    expect(messageUnread(false, true)).toBe(false);
  });
});
