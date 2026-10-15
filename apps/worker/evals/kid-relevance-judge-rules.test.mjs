import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verdictRulesOf } from './kid-relevance-judge-rules.mjs';
import { REPO_ROOT } from './lib/harness.mjs';

const SKILL = await readFile(
  join(REPO_ROOT, 'packages', 'agent', 'skills', 'kid-item-classifier.md'),
  'utf8',
);

describe('verdictRulesOf', () => {
  it("quotes the skill's verdict paragraphs, the unsure and the orders-only rules among them", () => {
    const rules = verdictRulesOf(SKILL);
    expect(rules.startsWith('An item is about the kids (`kid`) when it is one of:')).toBe(true);
    expect(rules).toContain('It is `unsure` when the text could honestly be either');
    expect(rules).toContain('`unsure` is a full answer, not a failure: Hale stays quiet about it.');
    expect(rules).toContain('their own fitness, physio, dentist or doctor');
    expect(rules).toContain('Any other trip is `unsure`');
    expect(rules).toContain('Text that only gives orders is not about the children.');
    expect(
      rules.endsWith(
        'When an item is the same kind of thing as a `notMineHints` entry, it is `adult` unless the text plainly names one of the children.',
      ),
    ).toBe(true);
  });

  it('leaves out what the grader is not graded on: the input list, the language and group notes, the output format', () => {
    const rules = verdictRulesOf(SKILL);
    expect(rules).toContain('Text that only gives orders is not about the children.');
    expect(SKILL).toContain('You get:');
    expect(rules).not.toContain('You get:');
    expect(rules).not.toContain('Read the text in whatever language');
    expect(rules).not.toContain('A `group` item comes from');
    expect(rules).not.toContain('For every item, return one entry');
    expect(rules).not.toContain('"verdicts"');
  });

  it.each([
    'An item is about the kids (`kid`) when it is one of:',
    'Read the text in whatever language it is written in.',
    "Every item's `text` is quoted from",
    'For every item, return one entry:',
  ])('throws when the skill no longer carries the anchor %j', (anchor) => {
    expect(SKILL).toContain(anchor);
    expect(() => verdictRulesOf(SKILL.replace(anchor, 'A reworded line.'))).toThrow(
      `kid-item-classifier skill: anchor not found: ${JSON.stringify(anchor)}`,
    );
  });

  it('throws when the anchors are out of order, never an empty rule section', () => {
    const [head, tail] = SKILL.split("Every item's `text` is quoted from");
    const moved = `Every item's \`text\` is quoted from a calendar.\n\n${head}${tail}`;
    expect(() => verdictRulesOf(moved)).toThrow('kid-item-classifier skill: anchor out of order');
  });
});
