import { describe, expect, it } from 'vitest';

import { notifDotOn } from './notif-dot';

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
