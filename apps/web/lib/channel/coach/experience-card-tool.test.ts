import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { linkRef } from './activity-links';
import {
  EXPERIENCE_CARD_TOOL,
  augmentCoachSkillForExperienceCards,
  experienceCardViolations,
  shareExperienceCardTool,
} from './experience-card-tool';

const PAGE = 'https://example.org/camp';
const LINKS = [{ ref: linkRef(PAGE), url: PAGE }];
const SKILL: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: ['lookup_week'] },
  instructions: 'x',
};

describe('share_experience_card (VIL-497)', () => {
  it('accepts a known ref and a free title with a time and a place (Design lock)', () => {
    expect(
      experienceCardViolations({ ref: LINKS[0]!.ref, title: 'Sat 10am · 123 King St' }, LINKS),
    ).toEqual([]);
  });

  it('refuses an unknown ref, an empty or long title, and a typed URL', () => {
    expect(experienceCardViolations({ ref: 'link-abcdef', title: 'ok' }, LINKS)).toHaveLength(1);
    expect(experienceCardViolations({ ref: LINKS[0]!.ref, title: '  ' }, LINKS)).toHaveLength(1);
    expect(
      experienceCardViolations({ ref: LINKS[0]!.ref, title: 'x'.repeat(65) }, LINKS),
    ).toHaveLength(1);
    expect(
      experienceCardViolations({ ref: LINKS[0]!.ref, title: 'see https://x.y' }, LINKS),
    ).toHaveLength(1);
  });

  it('resolves the url from the ref; the model never supplies one', async () => {
    const got: unknown[] = [];
    const tool = shareExperienceCardTool({ links: () => LINKS, onCard: (c) => got.push(c) });
    expect(tool.name).toBe(EXPERIENCE_CARD_TOOL);
    await tool.handler({ ref: LINKS[0]!.ref.toUpperCase(), title: ' Camp ' } as never, {} as never);
    expect(got).toEqual([{ url: PAGE, title: 'Camp' }]);
  });

  it('skill: dark is the same object; lit adds the verb and the addendum once', () => {
    const addendum: Skill = {
      meta: { name: 'experience-card-coach', whenToUse: 'x', task: 'converse', tools: [] },
      instructions: 'CALL THE CARD',
    };
    expect(augmentCoachSkillForExperienceCards(SKILL, null)).toBe(SKILL);
    const lit = augmentCoachSkillForExperienceCards(SKILL, addendum);
    expect(lit.meta.tools).toEqual(['lookup_week', EXPERIENCE_CARD_TOOL]);
    expect(lit.instructions).toBe(`${SKILL.instructions}\n\nCALL THE CARD`);
    expect(augmentCoachSkillForExperienceCards(lit, addendum)).toBe(lit);
  });

  it('lit addendum requires the card for one venue and skips a comparison; disk coach is unchanged', async () => {
    const disk = await loadCronSkill('coach-channel-sms');
    const addendum = await loadCronSkill('experience-card-coach');
    expect(disk.instructions).not.toContain(EXPERIENCE_CARD_TOOL);
    expect(disk.meta.tools).not.toContain(EXPERIENCE_CARD_TOOL);
    expect(augmentCoachSkillForExperienceCards(disk, null)).toBe(disk);
    const lit = augmentCoachSkillForExperienceCards(disk, addendum);
    expect(lit.instructions.startsWith(disk.instructions)).toBe(true);
    expect(lit.instructions).toMatch(/one venue's page/i);
    expect(lit.instructions).toMatch(/several classes or sessions/i);
    expect(lit.instructions).toMatch(/does not replace/i);
    expect(lit.instructions).toMatch(/different venues or different pages/i);
    expect(lit.meta.tools).toContain(EXPERIENCE_CARD_TOOL);
  });

  it('requires the card for one venue page, and says citing the ref does not replace the call', () => {
    const tool = shareExperienceCardTool({ links: () => [], onCard: () => {} });
    expect(tool.description).toMatch(/one venue's page/i);
    expect(tool.description).toMatch(/several classes or sessions/i);
    expect(tool.description).toMatch(/does not replace/i);
    expect(tool.description).toMatch(/different venues or different pages/i);
    expect(tool.description).not.toMatch(/just cite the \[link-…\] ref as usual/);
  });
});
