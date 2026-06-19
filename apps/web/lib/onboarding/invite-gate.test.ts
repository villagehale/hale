import { describe, expect, it } from 'vitest';
import { inviteGateDecision } from './invite-gate';

describe('inviteGateDecision', () => {
  const code = 'beta-secret';

  it('is open for everyone when the gate is off (public launch)', () => {
    expect(
      inviteGateDecision({ inviteOnly: false, code, param: null, cookie: undefined }),
    ).toEqual({ kind: 'open' });
    // off-state ignores the code entirely
    expect(
      inviteGateDecision({ inviteOnly: false, code: undefined, param: 'x', cookie: 'y' }),
    ).toEqual({ kind: 'open' });
  });

  it('grants and asks the caller to set a cookie on a matching ?invite= code', () => {
    expect(
      inviteGateDecision({ inviteOnly: true, code, param: 'beta-secret', cookie: undefined }),
    ).toEqual({ kind: 'grant' });
  });

  it('allows an already-invited visitor via a matching cookie', () => {
    expect(
      inviteGateDecision({ inviteOnly: true, code, param: null, cookie: 'beta-secret' }),
    ).toEqual({ kind: 'allow' });
  });

  it('denies a wrong code and a wrong cookie', () => {
    expect(
      inviteGateDecision({ inviteOnly: true, code, param: 'nope', cookie: 'also-nope' }),
    ).toEqual({ kind: 'deny' });
    expect(
      inviteGateDecision({ inviteOnly: true, code, param: null, cookie: undefined }),
    ).toEqual({ kind: 'deny' });
  });

  it('fails closed when the gate is on but no code is configured', () => {
    // an empty/absent code must never match an empty/absent param or cookie
    expect(
      inviteGateDecision({ inviteOnly: true, code: undefined, param: null, cookie: undefined }),
    ).toEqual({ kind: 'deny' });
    expect(
      inviteGateDecision({ inviteOnly: true, code: '', param: '', cookie: '' }),
    ).toEqual({ kind: 'deny' });
  });
});
