import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AuditEntry,
  type GuardDeps,
  type ToolHandlerContext,
  GuardrailError,
  defineTool,
  invokeTool,
} from './tool.js';

const ctx: ToolHandlerContext = { familyId: 'fam-1', actor: 'agent-run-1' };

function depsWith(overrides: Partial<GuardDeps> = {}): {
  deps: GuardDeps;
  audits: AuditEntry[];
} {
  const audits: AuditEntry[] = [];
  const deps: GuardDeps = {
    writeAudit: async (entry) => {
      audits.push(entry);
    },
    ...overrides,
  };
  return { deps, audits };
}

const orderTool = defineTool({
  name: 'place_supply_order',
  description: 'Order supplies.',
  monetary: true,
  inputSchema: z.object({ item: z.string(), priceUsd: z.number() }),
  handler: async (input: { item: string; priceUsd: number }) => ({ ordered: input.item }),
});

describe('invokeTool — spending-cap rail (rule #7)', () => {
  it('BLOCKS a monetary tool when the cap hook fails, and the handler never runs', async () => {
    const handler = vi.fn(async () => ({ ordered: 'diapers' }));
    const tool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      monetary: true,
      inputSchema: z.object({ item: z.string(), priceUsd: z.number() }),
      handler,
    });
    const { deps, audits } = depsWith({
      checkSpendingCap: async () => ({ ok: false, reason: 'over per-action cap' }),
      monetaryCostOf: (_name, input) => ({
        amountUsd: (input as { priceUsd: number }).priceUsd,
        category: 'supplies',
      }),
    });

    await expect(
      invokeTool(tool, { item: 'diapers', priceUsd: 999 }, ctx, deps),
    ).rejects.toBeInstanceOf(GuardrailError);
    expect(handler).not.toHaveBeenCalled();
    // A blocked call writes no audit row — nothing was authorized.
    expect(audits).toHaveLength(0);
  });

  it('runs the handler when the cap hook passes, and the cost is derived from input', async () => {
    const checkSpendingCap = vi.fn(async () => ({ ok: true, reason: 'within cap' }));
    const { deps } = depsWith({
      checkSpendingCap,
      monetaryCostOf: (_name, input) => ({
        amountUsd: (input as { priceUsd: number }).priceUsd,
        category: 'supplies',
      }),
    });

    const result = await invokeTool(orderTool, { item: 'wipes', priceUsd: 12 }, ctx, deps);

    expect(result).toEqual({ ordered: 'wipes' });
    expect(checkSpendingCap).toHaveBeenCalledWith('fam-1', { amountUsd: 12, category: 'supplies' });
  });

  it('fails closed: a monetary tool with no cap hook wired throws (never silently skips)', async () => {
    const { deps } = depsWith();
    await expect(invokeTool(orderTool, { item: 'wipes', priceUsd: 12 }, ctx, deps)).rejects.toThrow(
      /requires checkSpendingCap/,
    );
  });
});

describe('invokeTool — audit rail (rule #6)', () => {
  it('ALWAYS writes an audit row for a permitted invocation, carrying the validated input', async () => {
    const lookup = defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      inputSchema: z.object({ childId: z.string() }),
      handler: async (input: { childId: string }) => ({ ageMonths: 5, childId: input.childId }),
    });
    const { deps, audits } = depsWith();

    await invokeTool(lookup, { childId: 'kid-1' }, ctx, deps);

    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool:get_child_profile',
        after: { childId: 'kid-1' },
      },
    ]);
  });
});

describe('invokeTool — child-content rail (rule #1/#5)', () => {
  it('BLOCKS a child-content tool when the consent hook fails', async () => {
    const handler = vi.fn(async () => ({ raw: 'teen message text' }));
    const tool = defineTool({
      name: 'read_teen_message',
      description: 'Read a teen message.',
      touchesChildContent: true,
      inputSchema: z.object({ messageId: z.string() }),
      handler,
    });
    const { deps } = depsWith({
      checkChildContentAccess: async () => ({ ok: false, reason: 'no teen assent on file' }),
    });

    await expect(invokeTool(tool, { messageId: 'm-1' }, ctx, deps)).rejects.toBeInstanceOf(
      GuardrailError,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed: a child-content tool with no consent hook wired throws', async () => {
    const tool = defineTool({
      name: 'read_teen_message',
      description: 'Read a teen message.',
      touchesChildContent: true,
      inputSchema: z.object({ messageId: z.string() }),
      handler: async () => ({ raw: 'x' }),
    });
    const { deps } = depsWith();
    await expect(invokeTool(tool, { messageId: 'm-1' }, ctx, deps)).rejects.toThrow(
      /requires checkChildContentAccess/,
    );
  });
});

describe('invokeTool — input validation', () => {
  it('rejects hallucinated args at the boundary before any rail or handler runs', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      inputSchema: z.object({ childId: z.string() }),
      handler,
    });
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { childId: 42 }, ctx, deps)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});
