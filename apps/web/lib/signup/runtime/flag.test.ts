import { describe, expect, it } from 'vitest';
import { signupSandboxRuntimeEnabled } from './flag';

describe('signupSandboxRuntimeEnabled', () => {
  it('is on only for the exact string true', () => {
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: 'true' })).toBe(true);
  });

  it('stays off for every other value, including a trailing newline', () => {
    expect(signupSandboxRuntimeEnabled({})).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: '' })).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: 'true\n' })).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: 'TRUE' })).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: '1' })).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: 'on' })).toBe(false);
    expect(signupSandboxRuntimeEnabled({ SIGNUP_SANDBOX_RUNTIME_ENABLED: ' true' })).toBe(false);
  });
});
