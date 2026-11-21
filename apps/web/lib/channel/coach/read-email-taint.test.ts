import {
  type AuditEntry,
  GuardrailError,
  type RegisteredTool,
  defineTool,
  invokeTool,
  markUntrusted,
} from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dropEmailOnlyTokens } from './email-only-tokens';
import {
  READ_EMAIL_MAX_CHARS,
  READ_EMAIL_TOOL,
  type ReadEmailResult,
  coachEmailReader,
  readEmailTool,
  taintTurnOnEmailRead,
} from './read-email-tool';

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
  beforeEach(() => {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    // VIL-635: the refusal is a content-free tool_refused row, never a tool:<name> row.
    expect(audits.map((a) => a.actionTaken)).toEqual([`tool:${READ_EMAIL_TOOL}`, 'tool_refused']);
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

/**
 * VIL-560 · the mark's `&lt;` puts letters between digits, so the reply gate must read the
 * email as written while the model reads it marked. Real reader, tool, wrapper and gate.
 */
describe('read_email with the untrusted mark (VIL-560)', () => {
  const FLAG_STATES = [
    ['off', ''],
    ['on', 'true'],
  ] as const;
  const ONE_CODE = { phone: 0, code: 1, host: 0 };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function readThroughTheWrapper(flag: string, email: string) {
    vi.stubEnv('UNTRUSTED_FIELD_MARKING_ENABLED', flag);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = coachEmailReader({
      alertedSource: async () => ({
        kind: 'gmail',
        eventId: null,
        gmailMessageId: 'gm-1',
        private: false,
      }),
      familyChildren: async () => [],
      gmailConnection: async () => ({ id: 'integration-1' }),
      accessToken: async () => 'token-1',
      fetchBody: async () => email,
    });
    const turn = taintTurnOnEmailRead([
      readEmailTool((gmailMessageId) =>
        reader.read({
          familyId: 'family-1',
          parentUserId: 'parent-1',
          conversationId: 'conversation-1',
          gmailMessageId,
        }),
      ),
    ]);
    const tool = turn.tools.find((t) => t.name === READ_EMAIL_TOOL);
    if (!tool) throw new Error(`no ${READ_EMAIL_TOOL}`);
    const handed = await invokeTool(tool, { gmailMessageId: 'gm-1' }, CTX, {
      writeAudit: async () => {},
    });
    return { handed: handed as ReadEmailResult, emails: turn.emailTexts() };
  }

  describe.each(FLAG_STATES)('flag %s', (_state, flag) => {
    it.each([
      ['digits split with <', 'Enter code 48<29<13 at the door.', 'Enter code 48 29 13.'],
      ['a PIN that reads as a year', 'Your PIN is 19<87.', 'Your PIN is 1987.'],
      ['letters and digits split with <', 'Show AB<12<CD at the door.', 'Show AB 12 CD now.'],
      ['full-width <', 'Enter code 48\uFF1C29\uFF1C13 at the door.', 'Enter code 48 29 13.'],
      ['a CJK angle bracket', 'Enter code 48\u300829\u300813 at the door.', 'Enter code 48 29 13.'],
      ['the invisible tag <', 'Enter code 48\u{E003C}29\u{E003C}13 now.', 'Enter code 48 29 13.'],
    ])('drops a code the email split with %s', async (_label, email, reply) => {
      const { emails } = await readThroughTheWrapper(flag, email);
      expect(dropEmailOnlyTokens(reply, { emails, trusted: [] })).toEqual({
        text: '',
        dropped: ONE_CODE,
      });
    });

    it('drops the same code split with a dash (positive control)', async () => {
      const { emails } = await readThroughTheWrapper(flag, 'Enter code 48-29-13 at the door.');
      expect(dropEmailOnlyTokens('Enter code 48 29 13.', { emails, trusted: [] })).toEqual({
        text: '',
        dropped: ONE_CODE,
      });
    });

    it('leaves a reply that holds no email token byte for byte (positive control)', async () => {
      const { emails } = await readThroughTheWrapper(flag, 'Enter code 48<29<13 at the door.');
      const reply = 'Picture day is Friday.';
      expect(dropEmailOnlyTokens(reply, { emails, trusted: [] })).toEqual({
        text: reply,
        dropped: { phone: 0, code: 0, host: 0 },
      });
    });
  });

  it.each([
    ['off', '', (cut: string) => cut],
    ['on', 'true', (cut: string) => markUntrusted('email', 'body', cut)],
  ])(
    'flag %s: the gate holds the raw cut text and the model gets its exact form',
    async (_state, flag, forModel) => {
      const cut = `${'x'.repeat(READ_EMAIL_MAX_CHARS - 1)}<`;
      const { handed, emails } = await readThroughTheWrapper(flag, `${cut} past the cut`);
      expect(emails).toEqual([cut]);
      expect(handed).toEqual({ read: true, body: forModel(cut), truncated: true });
    },
  );
});
