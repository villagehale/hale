import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web phone-code funnel, as source. Events must fire from the UI the parent
 * sees — never from an account-oracle branch, never with a phone number in the
 * payload. Privacy-page copy is VIL-428 and is not edited here.
 */

const form = readFileSync(
  fileURLToPath(new URL('../../components/hale/claim-by-phone-form.tsx', import.meta.url)),
  'utf8',
);
const authorize = readFileSync(
  fileURLToPath(new URL('../auth/claim-phone-authorize.ts', import.meta.url)),
  'utf8',
);
const machine = readFileSync(
  fileURLToPath(new URL('../channel/intake/machine.ts', import.meta.url)),
  'utf8',
);
const layout = readFileSync(
  fileURLToPath(new URL('../../app/(authed)/layout.tsx', import.meta.url)),
  'utf8',
);

describe('web login / signup funnel instrumentation', () => {
  it('fires the phone-code steps from the form the parent uses', () => {
    expect(form).toContain("capture('login_phone_submitted')");
    expect(form).toContain("capture('login_code_sent')");
    expect(form).toContain("capture('login_failed', { reason: 'rate_limited' })");
    expect(form).toContain("capture('login_failed', { reason: 'invalid_request' })");
    expect(form).toContain("capture('login_failed', { reason: 'connection_error' })");
    expect(form).toContain("capture('login_failed', { reason: 'code_rejected' })");
    expect(form).toContain("capture('login_failed', { reason: 'expired' })");
    expect(form).toContain("capture('signup_started', { surface: 'sign_in' })");
  });

  it('never puts a phone number on a login_failed capture', () => {
    expect(form).not.toMatch(/login_failed[\s\S]{0,80}phone/);
  });

  it('does not treat HTTP 200 as an account oracle — login_code_sent fires on any 200', () => {
    expect(form).toContain("capture('login_code_sent')");
    expect(form).not.toContain('no_claimable_account');
    expect(form).not.toContain('not_a_parent');
  });

  it('masks the phone and code fields for replay and autocapture', () => {
    expect(form).toContain('ph-mask');
    expect(form).toContain('ph-no-capture');
    expect(form).toContain('data-hale-mask-input');
    expect(form).toContain('id="claim-phone"');
    expect(form).toContain('id="claim-code"');
  });

  it('records login_code_verified server-side on the hashed family id, never the phone', () => {
    expect(authorize).toContain("captureWebEvent('login_code_verified'");
    expect(authorize).toContain('hashFamilyId(result.familyId)');
    expect(authorize).not.toMatch(/captureWebEvent\(\s*'login_code_verified'[^)]*\bphone\b/);
  });

  it('records signup_completed from intake on the hashed family id, not through deps.capture', () => {
    expect(machine).toContain("captureWebEvent('signup_completed'");
    expect(machine).toContain('hashFamilyId(familyId)');
    expect(machine).not.toMatch(/\(deps\.capture\s*\?\?[\s\S]{0,80}signup_completed/);
  });

  it('identifies the portal user with a server-computed hash, never the raw family id', () => {
    expect(layout).toContain('hashFamilyId(familyId)');
    expect(layout).toContain('<IdentifyUser userId={analyticsId} />');
    expect(layout).not.toContain('<IdentifyUser userId={familyId} />');
  });
});
