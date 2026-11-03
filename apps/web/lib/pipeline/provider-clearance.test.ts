import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_PROVIDERS } from '~/lib/integrations/google-oauth';
import {
  GOOGLE_INTEGRATION_PROVIDER,
  type NonGoogleClearance,
  ProviderClearanceError,
  assertClearance,
  clearForNonAnthropic,
} from './provider-clearance';

/**
 * VIL-556: content Hale received from Google reaches Anthropic only. The decision lives
 * in ONE module; this file pins each origin's answer, the log a refusal leaves, and
 * that a clearance cannot be forged by a cast. The family_state witness on a real
 * schema is provider-clearance.pglite.test.ts.
 */

describe('clearForNonAnthropic', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('clears the parent’s own words, and the clearance passes the transport check', async () => {
    const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'test stage');
    if (!('cleared' in decision)) throw new Error(`expected cleared, got ${decision.refused}`);
    expect(decision.cleared.basis).toBe('parent_text');
    expect(() => assertClearance(decision.cleared)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses Google-derived input and logs the stage and refusal name only', async () => {
    expect(await clearForNonAnthropic({ kind: 'google' }, 'test stage')).toEqual({
      refused: 'google_derived_input',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      stage: 'test stage',
      refusal: 'google_derived_input',
    });
  });

  it('refuses an origin the caller cannot prove', async () => {
    expect(await clearForNonAnthropic({ kind: 'unproven' }, 'test stage')).toEqual({
      refused: 'origin_unproven',
    });
  });

  it('fails closed when the family witness cannot be read', async () => {
    const database = {
      execute: async () => {
        throw new Error('connection reset');
      },
    } as unknown as Database;
    expect(
      await clearForNonAnthropic(
        { kind: 'family_state', database, familyId: '00000000-0000-4000-8000-000000000001' },
        'test stage',
      ),
    ).toEqual({ refused: 'origin_unreadable' });
    expect(warn.mock.calls[0]?.[0]).toEqual({ stage: 'test stage', refusal: 'origin_unreadable' });
  });

  it('fails closed on a witness result it cannot read, rather than clearing', async () => {
    const database = { execute: async () => ({ unexpected: true }) } as unknown as Database;
    expect(
      await clearForNonAnthropic(
        { kind: 'family_state', database, familyId: '00000000-0000-4000-8000-000000000001' },
        'test stage',
      ),
    ).toEqual({ refused: 'origin_unreadable' });
  });
});

describe('assertClearance', () => {
  it('rejects a clearance that was cast rather than minted', () => {
    const forged = { basis: 'parent_text' } as unknown as NonGoogleClearance;
    expect(() => assertClearance(forged)).toThrow(ProviderClearanceError);
  });

  it('positive control: a minted clearance passes', async () => {
    const decision = await clearForNonAnthropic({ kind: 'parent_text' }, 'test stage');
    if (!('cleared' in decision)) throw new Error('expected cleared');
    expect(() => assertClearance(decision.cleared)).not.toThrow();
  });
});

describe('GOOGLE_INTEGRATION_PROVIDER', () => {
  it('classifies every integration_provider value, no more and no fewer', () => {
    expect(Object.keys(GOOGLE_INTEGRATION_PROVIDER).sort()).toEqual(
      [...schema.integrationProviderEnum.enumValues].sort(),
    );
  });

  it('counts exactly the Google providers, scaffolded ones included', () => {
    const google = Object.entries(GOOGLE_INTEGRATION_PROVIDER)
      .filter(([, isGoogle]) => isGoogle)
      .map(([provider]) => provider)
      .sort();
    expect(google).toEqual(['gcal', 'gdrive', 'gmail', 'google_classroom', 'google_photos']);
  });

  it('positive control: non-Google providers are not counted', () => {
    expect(GOOGLE_INTEGRATION_PROVIDER.stripe).toBe(false);
    expect(GOOGLE_INTEGRATION_PROVIDER.outlook).toBe(false);
    expect(GOOGLE_INTEGRATION_PROVIDER.apple_cal).toBe(false);
  });

  it('covers every live Google connector', () => {
    expect(CONNECTOR_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of CONNECTOR_PROVIDERS) {
      expect(GOOGLE_INTEGRATION_PROVIDER[provider]).toBe(true);
    }
  });
});
