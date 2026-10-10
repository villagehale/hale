import { defineTool, invokeTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { frameworkGuidanceTool } from './framework-tool';
import { buildGuardDeps } from './guards';

/**
 * Guard rails exercised through the real GuardDeps. The spending-cap cases use a
 * stand-in monetary tool (rule #7). `get_framework_guidance` is the live tool the
 * channel coach still registers; the age it is given has to be the age it answers
 * for (VIL-260).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

function fakeDb(audits: unknown[]): Database {
  const db = {
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        if (table === schema.auditLog) {
          audits.push(rows);
          return Promise.resolve(undefined);
        }
        throw new Error('unexpected insert target');
      },
    }),
  };
  return db as unknown as Database;
}

describe('tool guard rails', () => {
  it('blocks a monetary tool over the per-action cap and never audits (rule #7)', async () => {
    const audits: unknown[] = [];
    const db = fakeDb(audits);
    const monetaryTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ amountUsd: z.number(), category: z.string() }),
      monetary: true,
      touchesChildContent: false,
      handler: async () => ({ ordered: true }),
    });

    await expect(
      invokeTool(
        monetaryTool,
        { amountUsd: 5000, category: 'supplies' },
        { familyId: FAMILY_ID, actor: 'user-1' },
        buildGuardDeps(db),
      ),
    ).rejects.toThrow(/exceeds per-action cap/);

    expect(audits).toEqual([]);
  });

  it('allows a monetary tool within the cap, audits it, and runs the handler (rule #6/#7)', async () => {
    const audits: unknown[] = [];
    const db = fakeDb(audits);
    const monetaryTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ amountUsd: z.number(), category: z.string() }),
      monetary: true,
      touchesChildContent: false,
      handler: async () => ({ ordered: true }),
    });

    const result = await invokeTool(
      monetaryTool,
      { amountUsd: 12, category: 'supplies' },
      { familyId: FAMILY_ID, actor: 'user-1' },
      buildGuardDeps(db),
    );

    expect(result).toEqual({ ordered: true });
    expect(audits).toHaveLength(1);
  });

  it('get_framework_guidance answers for the AGE it is given, not the stage midpoint', async () => {
    // VIL-260 · WS5: 'child' spans four to twelve, so the midpoint reference DOB
    // answered a four-year-old's parent with an eight-year-old's milestones and
    // the Grade-7 immunization set. Asking about a 52-month-old must not.
    // Pin a month-end clock: Date.setMonth(Aug 31 minus 52) used to overflow
    // April 31 → May 1 and answer as 51 months.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T15:00:00-04:00'));
    const db = fakeDb([]);
    const ask = (input: Record<string, unknown>) =>
      invokeTool(
        frameworkGuidanceTool(),
        input,
        { familyId: FAMILY_ID, actor: 'user-1' },
        buildGuardDeps(db),
      ) as Promise<{
        ageMonths: number;
        whatsNow: readonly string[];
        milestones: Array<{ what: string }>;
        nextHealth: Array<{ what: string }>;
      }>;

    try {
      const preschooler = await ask({ stage: 'child', ageMonths: 52 });
      expect(preschooler.ageMonths).toBe(52);
      expect(preschooler.milestones.map((m) => m.what)).not.toContain(
        'Manages homework with some support',
      );
      expect(preschooler.nextHealth[0]?.what).not.toMatch(/pre-teen/i);

      // With no age the tool still answers, and the answer is the older child's.
      const unspecified = await ask({ stage: 'child' });
      expect(unspecified.whatsNow).not.toEqual(preschooler.whatsNow);
    } finally {
      vi.useRealTimers();
    }
  });
});
