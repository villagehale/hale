import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { GOOGLE_WRITE_SCOPES_ENABLED_ENV } from '~/lib/integrations/google-write-flag';
import { augmentCoachSkillForGoogleDrafts, prepareGmailDraftTool } from './gmail-draft-tool';
import { buildChannelCoachTools } from './tools';

const ctx = { familyId: 'fam', actor: 'user-a' };

describe('prepare_gmail_draft — flag gate', () => {
  const prev = process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
    else process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] = prev;
  });

  const built = () =>
    buildChannelCoachTools({
      familyId: 'f',
      reader: {} as never,
      draftPort: {} as never,
      villageTool: null,
      activity: null,
      spots: null,
      gmailDrafts: {
        gate: async () => ({ status: 'skipped', reason: 'flag_off' }),
        commit: async () => ({ status: 'skipped', reason: 'flag_off' }),
        composeNotice: async () => null,
      },
      onGmailNotice: () => {},
      now: new Date(),
    }).map((tool) => tool.name);

  it('leaves the cached coach skill and the tool list unchanged when the flag is off', async () => {
    delete process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV];
    const disk = await loadCronSkill('coach-channel-sms');
    const skill = await augmentCoachSkillForGoogleDrafts(disk);
    expect(skill.instructions).toBe(disk.instructions);
    expect(skill.meta.tools).not.toContain('prepare_gmail_draft');
    expect(built()).not.toContain('prepare_gmail_draft');
  });

  it('adds the tool and the loaded addendum only when the flag is on', async () => {
    process.env[GOOGLE_WRITE_SCOPES_ENABLED_ENV] = 'true';
    const disk = await loadCronSkill('coach-channel-sms');
    const skill = await augmentCoachSkillForGoogleDrafts(disk);
    expect(disk.meta.tools).not.toContain('prepare_gmail_draft');
    expect(skill.meta.tools).toContain('prepare_gmail_draft');
    expect(skill.instructions).toContain('prepare_gmail_draft');
    expect(skill.instructions).toContain('Do not ask them to reply YES');
    expect(built()).toContain('prepare_gmail_draft');
  });
});

describe('prepare_gmail_draft', () => {
  it('composes the notice before it writes, and returns that notice as the reply', async () => {
    const order: string[] = [];
    const boxes: unknown[] = [];
    const tool = prepareGmailDraftTool(
      {
        gate: async () => {
          order.push('gate');
          return { status: 'proceed' };
        },
        composeNotice: async () => {
          order.push('notice');
          return 'A draft is in your Gmail for you to send.';
        },
        commit: async () => {
          order.push('commit');
          return { status: 'drafted', draftId: 'd1', operation: 'create' };
        },
      },
      (box) => boxes.push(box),
    );

    const result = await tool.handler(
      { operation: 'create', body: 'Thursday works.', about: 'swim' },
      ctx,
    );
    expect(order).toEqual(['gate', 'notice', 'commit']);
    expect(result).toEqual({
      drafted: true,
      draftId: 'd1',
      notice: 'A draft is in your Gmail for you to send.',
    });
    expect(boxes).toEqual([{ status: 'ready', text: 'A draft is in your Gmail for you to send.' }]);
  });

  it('does not write a draft when the notice cannot be sent', async () => {
    const commit = vi.fn();
    const boxes: unknown[] = [];
    const tool = prepareGmailDraftTool(
      {
        gate: async () => ({ status: 'proceed' }),
        composeNotice: async () => null,
        commit,
      },
      (box) => boxes.push(box),
    );
    const result = await tool.handler({ operation: 'create', body: 'Thursday works.' }, ctx);
    expect(result).toEqual({ drafted: false, reason: 'notice_unsent' });
    expect(commit).not.toHaveBeenCalled();
    expect(boxes).toEqual([{ status: 'unsent' }]);
  });

  it('does not compose a success sentence when the scope is missing', async () => {
    const composeNotice = vi.fn();
    const tool = prepareGmailDraftTool(
      {
        gate: async () => ({ status: 'skipped', reason: 'scope_missing' }),
        composeNotice,
        commit: async () => ({ status: 'failed', reason: 'google_error' }),
      },
      () => {},
    );
    const result = await tool.handler({ operation: 'create', body: 'Thursday works.' }, ctx);
    expect(result).toEqual({ drafted: false, reason: 'scope_missing' });
    expect(composeNotice).not.toHaveBeenCalled();
  });
});
