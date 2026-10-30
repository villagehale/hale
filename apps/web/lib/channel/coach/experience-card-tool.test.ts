import type { Skill } from '@hale/agent';
import { describe, expect, it } from 'vitest';
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

  it('skill: dark is the same object; lit adds the verb once', () => {
    expect(augmentCoachSkillForExperienceCards(SKILL, false)).toBe(SKILL);
    const lit = augmentCoachSkillForExperienceCards(SKILL, true);
    expect(lit.meta.tools).toEqual(['lookup_week', EXPERIENCE_CARD_TOOL]);
    expect(augmentCoachSkillForExperienceCards(lit, true)).toBe(lit);
  });
});
