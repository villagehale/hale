import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClaimShadowContext } from '~/lib/channel/reconcile/candidate-rows';
import { createClaimEnforcer } from '~/lib/channel/reconcile/claim-enforce';
import { scriptedClaimReader } from '~/lib/testing/claim-reader';
import { passportDoorAllowsLine } from './fold';

/**
 * VIL-581 · the passport line is folded on after the coach's claim read, so this
 * door is the only read that sees it. A failed or unbacked line is dropped.
 */

const FAMILY = '00000000-0000-4000-8000-0000000000ab';
const NOW = new Date('2026-11-10T12:00:00Z');
const LINE = 'Maya is on swim this season.';
const database = {} as never;

function gate(script: Parameters<typeof scriptedClaimReader>[0] | 'no_zone', on = true) {
  const reader = scriptedClaimReader((segments) => (script === 'no_zone' ? [] : script(segments)));
  return {
    reader,
    enforcer: createClaimEnforcer({
      enforces: () => on,
      reader,
      loadContext: async () =>
        script === 'no_zone'
          ? ({ status: 'skipped', reason: 'no_time_zone' } satisfies ClaimShadowContext)
          : ({
              status: 'ready',
              rows: [],
              language: 'en',
              timeZone: 'America/New_York',
            } satisfies ClaimShadowContext),
    }),
  };
}

describe('the fold calls the door before it marks the stamp asked', () => {
  it('passportDoorAllowsLine sits above markAsked in fold.ts', () => {
    const src = readFileSync(fileURLToPath(new URL('./fold.ts', import.meta.url)), 'utf8');
    expect(src.indexOf('passportDoorAllowsLine(')).toBeGreaterThan(0);
    expect(src.indexOf('passportDoorAllowsLine(')).toBeLessThan(src.indexOf('markAsked('));
  });
});

describe('passportDoorAllowsLine', () => {
  const input = {
    familyId: FAMILY,
    parentUserId: 'parent-p',
    now: NOW,
    line: LINE,
  };

  it('leaves the line when the family is not enforced, and does not read', async () => {
    const { reader, enforcer } = gate(
      () => [{ segment: 0, kind: 'scheduled_event', row: 'none' }],
      false,
    );
    expect(await passportDoorAllowsLine(database, input, enforcer)).toBe(true);
    expect(reader.bodies).toEqual([]);
  });

  it('drops the line when the reader cites no row', async () => {
    const { reader, enforcer } = gate(() => [{ segment: 0, kind: 'scheduled_event', row: 'none' }]);
    expect(await passportDoorAllowsLine(database, input, enforcer)).toBe(false);
    expect(reader.bodies).toEqual([LINE]);
  });

  it('drops the line when the read failed', async () => {
    const { enforcer } = gate('no_zone');
    expect(await passportDoorAllowsLine(database, input, enforcer)).toBe(false);
  });

  it('keeps a line the reader finds no claim in', async () => {
    const { enforcer } = gate(() => []);
    expect(await passportDoorAllowsLine(database, input, enforcer)).toBe(true);
  });
});
