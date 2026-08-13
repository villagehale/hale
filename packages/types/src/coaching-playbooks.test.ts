import { describe, expect, it } from 'vitest';
import {
  type PlaybookTopic,
  goDeeperNames,
  hasPlaybook,
  playbookFor,
} from './coaching-playbooks.js';

/**
 * The anti-paraphrase gate.
 *
 * This content is true because it was checked against named sources IN THESE WORDS, so
 * the failure this file exists to catch is not a typo — it is a well-meaning edit that
 * smooths the prose and quietly un-verifies a claim. What is pinned below is every part
 * a rewrite would touch first: the method names Hale says out loud, the intervals a
 * parent will actually follow, the Canadian allergen framing that a US-trained editor
 * would "correct", and the shape the composer depends on being non-empty.
 *
 * The verified JSON itself is not in the repo (it lives in the gitignored research
 * directory), so this cannot diff against it. It pins the load-bearing anchors instead.
 */

const TOPICS: PlaybookTopic[] = ['sleep', 'potty', 'solids'];

describe('every playbook', () => {
  it.each(TOPICS)('%s carries the parts a plan is built from', (topic) => {
    const playbook = playbookFor(topic);

    // The composer grounds on all of these; an empty one is a plan with a hole in it.
    expect(playbook.primaryMethod.name.length).toBeGreaterThan(0);
    expect(playbook.primaryMethod.how.length).toBeGreaterThan(200);
    expect(playbook.primaryMethod.ageGate.length).toBeGreaterThan(0);
    expect(playbook.alternativeMethod.name.length).toBeGreaterThan(0);
    expect(playbook.readinessSigns.length).toBeGreaterThan(0);
    expect(playbook.neverDo.length).toBeGreaterThan(0);
    expect(playbook.doctorTriggers.length).toBeGreaterThan(0);
    expect(playbook.sources.length).toBeGreaterThan(0);
  });

  it.each(TOPICS)('%s offers at least one vetted name and no bare list of URLs', (topic) => {
    const names = goDeeperNames(topic);

    expect(names.length).toBeGreaterThan(0);
    for (const creator of playbookFor(topic).goDeeper) {
      expect(creator.credential.length).toBeGreaterThan(0);
      // The provenance note is what lets a citation be re-checked without re-running
      // the research pass. A creator with an empty one is a creator nobody verified.
      expect(creator.verified.length).toBeGreaterThan(0);
    }
  });
});

describe('the named methods', () => {
  it('says Ferber for sleep, by name', () => {
    // The founder's requirement in one assertion: a plan that will not name its method
    // is a plan a parent cannot look up or tell their partner about.
    expect(playbookFor('sleep').primaryMethod.name).toContain('Ferber');
  });

  it('keeps the graduated intervals a parent actually follows', () => {
    const how = playbookFor('sleep').primaryMethod.how;

    // Night 1 is 3 / 5 / 10. These are the numbers a family sets a timer by, and a
    // paraphrase that rounds them is a different method.
    expect(how).toContain('3 minutes');
    expect(how).toContain('Night 2');
  });

  it('says the 3-day method for potty', () => {
    expect(playbookFor('potty').primaryMethod.name.toLowerCase()).toContain('3-day');
  });

  it('names the extinction burst rather than only the good nights', () => {
    // The single most useful sentence in the sleep plan: the night it looks like it is
    // failing is the night it is working. Losing this to an edit costs a family the
    // method.
    expect(playbookFor('sleep').primaryMethod.how).toContain('extinction burst');
  });
});

describe('the solids playbook', () => {
  it('keeps the CANADIAN allergen framing, not the US big 9', () => {
    const text = JSON.stringify(playbookFor('solids'));

    // A refutation applied during verification. "Big 9" is the US list; CPS/Health
    // Canada name a priority list, and an editor who "fixes" this re-introduces the bug.
    expect(text.toLowerCase()).not.toContain('big 9');
    expect(text.toLowerCase()).not.toContain('big nine');
  });

  it('holds the honey rule, which is the one that kills', () => {
    expect(playbookFor('solids').neverDo.join(' ')).toContain('honey before 12 months');
  });
});

describe('hasPlaybook', () => {
  it('admits the three topics that have curated methods', () => {
    for (const topic of TOPICS) expect(hasPlaybook(topic)).toBe(true);
  });

  it('refuses the plan topics that have none rather than inventing one', () => {
    // The plan arc offers seven topics; four have no studied method to name. The caller
    // must be able to tell, because grounding a plan on an empty playbook is exactly
    // the improvisation the playbooks exist to stop.
    for (const topic of ['tantrums', 'screen_time', 'routines', 'picky_eating']) {
      expect(hasPlaybook(topic)).toBe(false);
    }
  });
});
