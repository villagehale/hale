import { describe, expect, it } from 'vitest';
import { loadSkill, parseSkill } from './skill.js';

const SKILL = `---
name: ask-hale
whenToUse: A parent asks a parenting question.
task: converse
tools:
  - get_child_profile
  - search_memory
---

# Ask Hale

You answer parenting questions.
`;

describe('parseSkill', () => {
  it('parses frontmatter into typed meta + body instructions', () => {
    const skill = parseSkill(SKILL);
    expect(skill.meta).toEqual({
      name: 'ask-hale',
      whenToUse: 'A parent asks a parenting question.',
      task: 'converse',
      tools: ['get_child_profile', 'search_memory'],
    });
    expect(skill.instructions).toBe('# Ask Hale\n\nYou answer parenting questions.');
  });

  it('parses a flow-style tools array', () => {
    const raw = `---
name: t
whenToUse: x
task: classify
tools: [a, b, c]
---
body
`;
    expect(parseSkill(raw).meta.tools).toEqual(['a', 'b', 'c']);
  });

  it('rejects a task that is not a known AgentTask', () => {
    const raw = SKILL.replace('task: converse', 'task: judge');
    expect(() => parseSkill(raw)).toThrow(/not a known AgentTask/);
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => parseSkill('# Just a body, no frontmatter')).toThrow(/frontmatter/);
  });

  it('rejects an empty instructions body', () => {
    const raw = `---
name: t
whenToUse: x
task: classify
tools: []
---
`;
    expect(() => parseSkill(raw)).toThrow(/empty instructions/);
  });

  it('rejects a non-string scalar field given as a list', () => {
    const raw = `---
name:
  - a
whenToUse: x
task: classify
tools: []
---
body
`;
    expect(() => parseSkill(raw)).toThrow(/'name' must be a string/);
  });
});

describe('loadSkill', () => {
  it('loads the bundled ask-hale skill by bare name', async () => {
    const skill = await loadSkill('ask-hale');
    expect(skill.meta.name).toBe('ask-hale');
    expect(skill.meta.task).toBe('converse');
    expect(skill.meta.tools).toContain('get_child_profile');
    expect(skill.instructions.length).toBeGreaterThan(0);
  });

  /** Two more bundled skills, on two other task tiers — `task` is what `pickModel`
   * reads, so a skill whose tier does not survive the parse is one that silently runs on
   * the wrong model. It named find-activities and log-care until those were deleted as
   * dead (skill audit #9/#10); these are the live skills on the same two tiers. */
  it('parses the task tier of skills that are not converse', async () => {
    const curate = await loadSkill('curate-shortlist');
    expect(curate.meta.task).toBe('discover');
    const classify = await loadSkill('classify-event');
    expect(classify.meta.task).toBe('classify');
  });
});
