import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AuditEntry,
  type GuardDeps,
  GuardrailError,
  type ToolHandlerContext,
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
  touchesChildContent: false,
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
      touchesChildContent: false,
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
    // Content-free refusal: tool + rail, never the input, no audience on a non-user actor.
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool_refused',
        after: { tool: 'place_supply_order', rail: 'spending_cap' },
        audience: null,
      },
    ]);
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
    const handler = vi.fn(async () => ({ ordered: 'wipes' }));
    const tool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      monetary: true,
      touchesChildContent: false,
      inputSchema: z.object({ item: z.string(), priceUsd: z.number() }),
      handler,
    });
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { item: 'wipes', priceUsd: 12 }, ctx, deps)).rejects.toThrow(
      /requires checkSpendingCap/,
    );
    // Fail-closed means nothing happened: no spend, and no audit row claiming one.
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('fails closed on PARTIAL wiring: the cap hook without monetaryCostOf still throws', async () => {
    const checkSpendingCap = vi.fn(async () => ({ ok: true, reason: 'within cap' }));
    const { deps, audits } = depsWith({ checkSpendingCap });

    await expect(invokeTool(orderTool, { item: 'wipes', priceUsd: 12 }, ctx, deps)).rejects.toThrow(
      /requires checkSpendingCap \+ monetaryCostOf/,
    );
    // Half a cap check is no cap check: without a cost there is nothing to compare
    // against the cap, so the hook must not be consulted at all (rule #7).
    expect(checkSpendingCap).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe('invokeTool — audit rail (rule #6)', () => {
  it('ALWAYS writes an audit row for a permitted invocation, carrying the validated input', async () => {
    const lookup = defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      monetary: false,
      touchesChildContent: true,
      inputSchema: z.object({ childId: z.string() }),
      handler: async (input: { childId: string }) => ({ ageMonths: 5, childId: input.childId }),
    });
    const { deps, audits } = depsWith({
      checkChildContentAccess: async () => ({ ok: true, reason: 'child is under 13' }),
    });

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
      monetary: false,
      touchesChildContent: true,
      inputSchema: z.object({ messageId: z.string() }),
      handler,
    });
    const { deps, audits } = depsWith({
      checkChildContentAccess: async () => ({ ok: false, reason: 'no teen assent on file' }),
    });

    await expect(invokeTool(tool, { messageId: 'm-1' }, ctx, deps)).rejects.toBeInstanceOf(
      GuardrailError,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool_refused',
        after: { tool: 'read_teen_message', rail: 'child_content' },
        audience: null,
      },
    ]);
  });

  it('fails closed: a child-content tool with no consent hook wired throws', async () => {
    const handler = vi.fn(async () => ({ raw: 'teen message text' }));
    const tool = defineTool({
      name: 'read_teen_message',
      description: 'Read a teen message.',
      monetary: false,
      touchesChildContent: true,
      inputSchema: z.object({ messageId: z.string() }),
      handler,
    });
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { messageId: 'm-1' }, ctx, deps)).rejects.toThrow(
      /requires checkChildContentAccess/,
    );
    // The raw teen content was never read, and no audit row implies it was.
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});

describe('invokeTool — untrusted-content rail (VIL-616)', () => {
  function gatedTool(gate: () => { ok: boolean; reason: string }) {
    const handler = vi.fn(async () => ({ drafted: true }));
    const tool = defineTool({
      name: 'propose_calendar_add',
      description: 'Draft a calendar entry.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ title: z.string() }),
      untrustedContentGate: gate,
      handler,
    });
    return { tool, handler };
  }

  it('a refused call writes NO audit row: the input never reaches audit_log', async () => {
    const { tool, handler } = gatedTool(() => ({ ok: false, reason: 'email_read_this_turn' }));
    const { deps, audits } = depsWith();

    const refusal = await invokeTool(tool, { title: 'Pickup with a stranger' }, ctx, deps).catch(
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(GuardrailError);
    expect(refusal).toMatchObject({ toolName: 'propose_calendar_add', rail: 'untrusted_content' });
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool_refused',
        after: { tool: 'propose_calendar_add', rail: 'untrusted_content' },
        audience: null,
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('Pickup with a stranger');
  });

  it('a call the gate lets through is audited and runs (positive control)', async () => {
    const { tool, handler } = gatedTool(() => ({ ok: true, reason: 'untainted' }));
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { title: 'Swim' }, ctx, deps)).resolves.toEqual({
      drafted: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(audits.map((a) => a.actionTaken)).toEqual(['tool:propose_calendar_add']);
  });
});

describe('invokeTool — input-aware child-content gate (VIL-618)', () => {
  function gatedTool() {
    const handler = vi.fn(async () => ({ saved: true }));
    const tool = defineTool({
      name: 'save_memory',
      description: 'Save a fact.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ factValue: z.string() }),
      childContentGate: async (input: { factValue: string }, gateCtx: ToolHandlerContext) =>
        gateCtx.familyId === ctx.familyId && input.factValue.includes('Tamsin')
          ? { ok: false, reason: 'names_teen' }
          : { ok: true, reason: 'names_no_teen' },
      handler,
    });
    return { tool, handler };
  }

  it('a refused input writes NO audit row and the handler never runs', async () => {
    const { tool, handler } = gatedTool();
    const { deps, audits } = depsWith();

    const refusal = await invokeTool(tool, { factValue: 'Tamsin has a secret' }, ctx, deps).catch(
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(GuardrailError);
    expect(refusal).toMatchObject({ toolName: 'save_memory', rail: 'child_content' });
    expect((refusal as Error).message).toContain('names_teen');
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool_refused',
        after: { tool: 'save_memory', rail: 'child_content' },
        audience: null,
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('Tamsin');
  });

  it('an input the gate lets through is audited and runs (positive control)', async () => {
    const { tool, handler } = gatedTool();
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { factValue: 'library on Sundays' }, ctx, deps)).resolves.toEqual(
      { saved: true },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(audits.map((a) => a.after)).toEqual([{ factValue: 'library on Sundays' }]);
  });
});

describe('invokeTool — refusal audience (VIL-635)', () => {
  it('names the adult as audience when the actor is a users.id', async () => {
    const parent = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const handler = vi.fn(async () => ({ drafted: true }));
    const tool = defineTool({
      name: 'propose_calendar_add',
      description: 'Draft a calendar entry.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ title: z.string() }),
      untrustedContentGate: () => ({ ok: false, reason: 'email_read_this_turn' }),
      handler,
    });
    const { deps, audits } = depsWith();

    await expect(
      invokeTool(tool, { title: 'secret' }, { familyId: 'fam-1', actor: parent }, deps),
    ).rejects.toBeInstanceOf(GuardrailError);
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: parent,
        actionTaken: 'tool_refused',
        after: { tool: 'propose_calendar_add', rail: 'untrusted_content' },
        audience: parent,
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('secret');
  });
});

describe('invokeTool — input validation', () => {
  it('rejects hallucinated args at the boundary before any rail or handler runs', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ childId: z.string() }),
      handler,
    });
    const { deps, audits } = depsWith();

    await expect(invokeTool(tool, { childId: 42 }, ctx, deps)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });
});
