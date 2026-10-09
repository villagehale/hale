import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After the auth gate has parked a deep link on /sign-in?callbackUrl=…, every
 * sign-in path has to land on that path. These tests drive the real actions
 * with Auth.js stubbed at the signIn boundary.
 */

const { signIn, redirect } = vi.hoisted(() => ({
  signIn: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  }),
}));

vi.mock('next-auth', () => ({
  AuthError: class AuthError extends Error {
    type = 'CredentialsSignin';
  },
}));
vi.mock('~/auth', () => ({ signIn }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));

import { claimByPhoneAction } from './claim-phone-actions';
import { redeemMagicLinkAction } from './magic-link-actions';

beforeEach(() => {
  vi.clearAllMocks();
  signIn.mockResolvedValue(undefined);
  redirect.mockImplementation((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  });
});

describe('post-sign-in return path', () => {
  it('sends a successful phone/OTP sign-in to /messages', async () => {
    await expect(claimByPhoneAction('+14165550100', '123456', '/messages')).rejects.toThrow(
      'REDIRECT:/messages',
    );
    expect(signIn).toHaveBeenCalledWith('claim-phone', {
      phone: '+14165550100',
      code: '123456',
      redirectTo: '/messages',
    });
  });

  it('sends a successful magic-link sign-in to /messages', async () => {
    await expect(
      redeemMagicLinkAction('tok', '/messages', { status: 'idle' }, new FormData()),
    ).rejects.toThrow('REDIRECT:/messages');
    expect(signIn).toHaveBeenCalledWith('magic-link', {
      token: 'tok',
      redirectTo: '/messages',
    });
  });

  it('drops an off-site callback and lands on home', async () => {
    await expect(claimByPhoneAction('+14165550100', '123456', 'https://evil.com')).rejects.toThrow(
      'REDIRECT:/home',
    );
    expect(signIn).toHaveBeenCalledWith(
      'claim-phone',
      expect.objectContaining({ redirectTo: '/home' }),
    );
  });
});
