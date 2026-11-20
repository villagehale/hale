import { describe, expect, it } from 'vitest';
import { parseSkill } from '../../../../packages/agent/src/skill.ts';
import { cacheKey } from './harness.mjs';

/**
 * The saved eval cache key hashes `skill.instructions` — the body `parseSkill`
 * hands the model — through `cacheKey`. Whitespace, a comment, or a
 * frontmatter-metadata-only edit should not mint a new key, because that drops
 * saved recordings. This file does not change the key. A case that still moves
 * it is `it.todo`, with the reason.
 */

const BASE = `---
name: ask-hale
whenToUse: A parent asks a parenting question.
task: converse
tools: []
---

# Ask Hale

You answer parenting questions.
`;

function savedKey(raw) {
  const instructions = parseSkill(raw).instructions;
  return cacheKey('skill', JSON.stringify({ system: instructions, prompt: instructions }));
}

const baseKey = savedKey(BASE);

describe('saved eval cache key', () => {
  it('moves when the instructions change', () => {
    const edited = BASE.replace(
      'You answer parenting questions.',
      'You answer parenting questions now.',
    );
    expect(savedKey(edited)).not.toBe(baseKey);
  });

  it('keeps the key when only frontmatter metadata changes', () => {
    const renamed = BASE.replace('name: ask-hale', 'name: ask-hale-renamed');
    const retold = BASE.replace(
      'whenToUse: A parent asks a parenting question.',
      'whenToUse: Metadata only, not the prompt.',
    );
    const spaced = BASE.replace('tools: []\n', 'tools: []\n\n');
    const noted = BASE.replace(
      'whenToUse: A parent asks a parenting question.',
      'whenToUse: A parent asks a parenting question. # note',
    );
    expect(savedKey(renamed)).toBe(baseKey);
    expect(savedKey(retold)).toBe(baseKey);
    expect(savedKey(spaced)).toBe(baseKey);
    expect(savedKey(noted)).toBe(baseKey);
  });

  it('keeps the key when only leading or trailing body whitespace changes', () => {
    const padded = `${BASE.replace('# Ask Hale', '\n\n# Ask Hale')}\n\n`;
    expect(savedKey(padded)).toBe(baseKey);
  });

  // parseSkill trims only the ends of the body. cacheKey then hashes
  // skill.instructions verbatim, so a blank line inside the body mints a new
  // key and would drop saved recordings. This PR does not change the key.
  it.todo(
    'a whitespace-only edit inside the skill body keeps the saved cache key — today a blank line changes skill.instructions, and cacheKey hashes that verbatim',
  );

  // A markdown comment is body text. It changes skill.instructions, so the
  // saved key changes with it. This PR does not change the key.
  it.todo(
    'a comment-only edit inside the skill body keeps the saved cache key — today a markdown comment is instructions, and cacheKey hashes that verbatim',
  );
});
