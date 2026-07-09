import { describe, expect, it } from 'vitest';
import { loadAskHaleSkill } from './skill';
import { buildAskHaleTools } from './tools';

/**
 * The live-path parity gate: every tool `buildAskHaleTools` registers must be in
 * the REAL `ask-hale` skill's `tools:` allowlist. `toAnthropicTools` only offers
 * the model tools named in the frontmatter, so a registered-but-unlisted tool is a
 * silent no-op — the model can never call it, no card ever streams. This is the
 * exact drift that shipped drive_search / calendar_lookup as dead code. Loading the
 * real skill (not a fixture) is what makes it a gate: drop a name from the
 * frontmatter and this turns red.
 */
describe('ask-hale registered tools ⊆ skill allowlist (live path)', () => {
  it('every tool buildAskHaleTools registers is offered to the model by the skill', async () => {
    const skill = await loadAskHaleSkill();
    const registered = buildAskHaleTools({} as never).map((t) => t.name);
    const allowlist = new Set(skill.meta.tools);

    const unlisted = registered.filter((name) => !allowlist.has(name));
    expect(unlisted).toEqual([]);
  });
});
