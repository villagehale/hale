import {
  type AuditEntry,
  GuardrailError,
  type RegisteredTool,
  defineTool,
  invokeTool,
} from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { READ_EMAIL_TOOL, type ReadEmailResult, taintTurnOnEmailRead } from './read-email-tool';

/**
 * VIL-615 · once `read_email` hands the turn an email's text, nothing that writes or
 * sends may run for the rest of the turn. VIL-616 · and a refused call writes no audit
 * row, so input the email may have written never reaches the family's audit trail.
 * Pure: real tool objects through the real `invokeTool`, recording handlers and audit.
 */

const CTX = { familyId: 'family-1', actor: 'parent-1' };

function recording(name: string, ran: string[]): RegisteredTool {
  return defineTool({
    name,
    description: name,
    inputSchema: z.object({}),
    monetary: false,
    touchesChildContent: false,
    handler: async () => {
      ran.push(name);
      return { ok: true };
    },
  });
}

function emailTool(result: ReadEmailResult, ran: string[]): RegisteredTool {
  return defineTool({
    name: READ_EMAIL_TOOL,
    description: READ_EMAIL_TOOL,
    inputSchema: z.object({ gmailMessageId: z.string() }),
    monetary: false,
    touchesChildContent: false,
    handler: async () => {
      ran.push(READ_EMAIL_TOOL);
      return result;
    },
  });
}

const READ: ReadEmailResult = { read: true, body: 'Picture day is Friday.', truncated: false };

function turnTools(result: ReadEmailResult, ran: string[], audits: AuditEntry[] = []) {
  const turn = taintTurnOnEmailRead([
    emailTool(result, ran),
    recording('propose_calendar_add', ran),
    recording('watch_for_opening', ran),
    recording('lookup_week', ran),
    recording('a_tool_added_next_year', ran),
  ]);
  const deps = {
    writeAudit: async (entry: AuditEntry) => {
      audits.push(entry);
    },
  };
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const tool = turn.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return invokeTool(
      tool,
      name === READ_EMAIL_TOOL ? { gmailMessageId: 'gm-1' } : input,
      CTX,
      deps,
    );
  };
  return { tools: turn.tools, emailRead: turn.emailRead, call };
}

describe('taintTurnOnEmailRead (VIL-615)', () => {
  it('a write before any email is read runs (positive control)', async () => {
    const ran: string[] = [];
    const { call } = turnTools(READ, ran);
    await expect(call('propose_calendar_add')).resolves.toEqual({ ok: true });
    expect(ran).toEqual(['propose_calendar_add']);
  });

  it('after read_email returns text, every write is refused and its handler never runs', async () => {
    const ran: string[] = [];
    const { call } = turnTools(READ, ran);
    await expect(call(READ_EMAIL_TOOL)).resolves.toEqual(READ);
    for (const name of ['propose_calendar_add', 'watch_for_opening']) {
      const refusal = await call(name).catch((err: unknown) => err);
      expect(refusal).toBeInstanceOf(GuardrailError);
      expect(refusal).toMatchObject({ toolName: name, rail: 'untrusted_content' });
    }
    expect(ran).toEqual([READ_EMAIL_TOOL]);
  });

  it('a refused call leaves no audit row, so its input never reaches the family export (VIL-616)', async () => {
    const ran: string[] = [];
    const audits: AuditEntry[] = [];
    const { call } = turnTools(READ, ran, audits);
    await call(READ_EMAIL_TOOL);
    await call('propose_calendar_add').catch(() => {});
    expect(audits.map((a) => a.actionTaken)).toEqual([`tool:${READ_EMAIL_TOOL}`]);
  });

  it('a write before the read is audited as usual (positive control for the row above)', async () => {
    const ran: string[] = [];
    const audits: AuditEntry[] = [];
    const { call } = turnTools(READ, ran, audits);
    await call('propose_calendar_add');
    expect(audits.map((a) => a.actionTaken)).toEqual(['tool:propose_calendar_add']);
  });

  it('says whether this turn read an email, for the thread row the reply lands in', async () => {
    const ran: string[] = [];
    const { call, emailRead } = turnTools(READ, ran);
    expect(emailRead()).toBe(false);
    await call('lookup_week');
    expect(emailRead()).toBe(false);
    await call(READ_EMAIL_TOOL);
    expect(emailRead()).toBe(true);
  });

  it('a refused read is not a read', async () => {
    const ran: string[] = [];
    const { call, emailRead } = turnTools({ read: false, reason: 'private' }, ran);
    await call(READ_EMAIL_TOOL);
    expect(emailRead()).toBe(false);
  });

  it('a tool nobody classified is refused too: the allow-list fails closed', async () => {
    const ran: string[] = [];
    const { call } = turnTools(READ, ran);
    await call(READ_EMAIL_TOOL);
    await expect(call('a_tool_added_next_year')).rejects.toBeInstanceOf(GuardrailError);
    expect(ran).not.toContain('a_tool_added_next_year');
  });

  it('a read still runs after the email, and so does a second read_email', async () => {
    const ran: string[] = [];
    const { call } = turnTools(READ, ran);
    await call(READ_EMAIL_TOOL);
    await expect(call('lookup_week')).resolves.toEqual({ ok: true });
    await expect(call(READ_EMAIL_TOOL)).resolves.toEqual(READ);
    expect(ran).toEqual([READ_EMAIL_TOOL, 'lookup_week', READ_EMAIL_TOOL]);
  });

  it('a refused read hands the turn no text, so it taints nothing', async () => {
    const ran: string[] = [];
    const { call } = turnTools({ read: false, reason: 'not_alerted' }, ran);
    await call(READ_EMAIL_TOOL);
    await expect(call('propose_calendar_add')).resolves.toEqual({ ok: true });
    expect(ran).toEqual([READ_EMAIL_TOOL, 'propose_calendar_add']);
  });

  it('each wrap is its own turn: a new tool set starts untainted', async () => {
    const ran: string[] = [];
    await turnTools(READ, ran).call(READ_EMAIL_TOOL);
    await expect(turnTools(READ, ran).call('propose_calendar_add')).resolves.toEqual({ ok: true });
  });

  it('keeps each tool’s declared metadata', () => {
    const ran: string[] = [];
    const original = recording('promise_activity_followup', ran);
    const [wrapped] = taintTurnOnEmailRead([{ ...original, registersOnly: true }]).tools;
    expect(wrapped).toMatchObject({
      name: 'promise_activity_followup',
      registersOnly: true,
      monetary: false,
      touchesChildContent: false,
    });
  });
});
