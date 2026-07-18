import { describe, expect, it } from 'vitest';

import { resumeDestination } from './resume-destination';

/**
 * The pure routing decision the root layout's resume effect makes after an authed
 * load. Extracted so the 13-step order's post-auth entry point is unit-testable
 * (the effect itself needs React + expo-router). Expected values are derived from
 * the A-prime flow: a just-submitted draft enters the post-auth tail at step 11
 * (/preview → connect → consent), NOT the app root. The tabs bounce only happens
 * on the held-but-nothing-to-do paths.
 */
describe('resumeDestination', () => {
  it('sends a freshly submitted draft into the post-auth getting-ready step (11)', () => {
    expect(resumeDestination({ kind: 'submitted' })).toBe('/preview');
  });

  it('lands a held load with no draft in the app (the gate deferred to us)', () => {
    expect(resumeDestination({ kind: 'no-draft', held: true })).toBe('/(tabs)');
  });

  it('leaves an unheld load with no draft alone (the gate handles it)', () => {
    expect(resumeDestination({ kind: 'no-draft', held: false })).toBeNull();
  });

  it('lands a held load in the app when submit fails (never crash the shell)', () => {
    expect(resumeDestination({ kind: 'failed', held: true })).toBe('/(tabs)');
  });

  it('leaves an unheld failed submit alone, so the draft retries on the next load', () => {
    expect(resumeDestination({ kind: 'failed', held: false })).toBeNull();
  });
});
