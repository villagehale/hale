import { describe, expect, it } from 'vitest';
import { postAuthHold, setPostAuthHold } from './post-auth-hold';

describe('postAuthHold', () => {
  it('reads synchronously what was set — no render cycle required', () => {
    expect(postAuthHold()).toBe(false);
    setPostAuthHold(true);
    expect(postAuthHold()).toBe(true);
    setPostAuthHold(false);
    expect(postAuthHold()).toBe(false);
  });
});
