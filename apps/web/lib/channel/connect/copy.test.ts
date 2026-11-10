import { describe, expect, it } from 'vitest';
import { certainLanguageHint } from '~/lib/channel/language';
import { saidLineUserMessage } from '~/lib/channel/voice/said-line';
import { connectorRevokeLineInput } from './copy';
import type { ConnectorRevokeOutcome } from './revoke';

interface RevokeFixture {
  id: string;
  purpose: string;
  language: string;
  languageHint: string;
  parentWords: string;
  revokeOutcome: ConnectorRevokeOutcome;
  facts: Record<string, unknown>;
  mustInclude: string[];
  mustConvey?: string[];
}

/**
 * The said-line eval replicates the disconnect reply's request (it cannot reach `~/`), and
 * its cache key depends on every byte of it. This rebuilds each replayed request with the
 * production builder, so a drift fails here, for free, before it can mis-key a recording.
 */
describe('the said-line eval replays the production disconnect reply', () => {
  it('every connector_revoke fixture is the request connectorRevokeLineInput builds', async () => {
    const path = '../../../../worker/evals/said-line-fixtures.mjs';
    const { SAID_LINE_FIXTURES } = (await import(/* @vite-ignore */ path)) as {
      SAID_LINE_FIXTURES: Array<{ purpose: string }>;
    };
    const fixtures = SAID_LINE_FIXTURES.filter(
      (fixture) => fixture.purpose === 'connector_revoke',
    ) as RevokeFixture[];
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    for (const fixture of fixtures) {
      const production = connectorRevokeLineInput({
        language: fixture.language,
        parentWords: fixture.parentWords,
        outcome: fixture.revokeOutcome,
      });
      expect(certainLanguageHint(fixture.language), fixture.id).toBe(fixture.languageHint);
      expect(production.facts, fixture.id).toEqual(fixture.facts);
      expect(production.mustConvey, fixture.id).toEqual(fixture.mustConvey);
      expect(production.mustInclude ?? [], fixture.id).toEqual(fixture.mustInclude);
      expect(production.links, fixture.id).toBeUndefined();
    }
  });

  it('never hands the writer a link or Google’s removal page', () => {
    const message = saidLineUserMessage(
      connectorRevokeLineInput({
        language: 'en',
        parentWords: 'disconnect my calendar',
        outcome: { status: 'revoked', providers: ['gcal', 'gmail'], google: 'pending_retry' },
      }),
    );
    expect(message).toContain('bothOff');
    expect(message).not.toContain('myaccount.google.com');
    expect(message).not.toMatch(/https?:\/\//);
    expect(JSON.parse(message).linkSlots).toEqual([]);
  });
});
