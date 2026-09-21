import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_SAMPLE_WORDS,
  skillSampleSentences,
  variationGate,
} from './variation.mjs';

/**
 * THE PARROT HALF OF THE GATE, AND THE LENGTH IT STOPS WORKING AT.
 *
 * `variation.mjs` drops any skill example and any output sentence under
 * DEFAULT_MIN_SAMPLE_WORDS words, and the constant's own comment says why: the phrases a
 * voice skill exists to TEACH ("no need to write back", "even a word is fine") are five
 * or six words, and a parrot gate that fires on them forbids the skill from working.
 * Seven is where the FOLLOWUP corpus separates cleanly — which is a statement about one
 * corpus, not a universal.
 *
 * The alert aside is a 3-10 word clause. At the default, its skill's example lines are
 * never harvested and its output sentences are never scanned, so the containment check
 * is dead for the whole corpus and a skill that shows one good clause would have it
 * copied straight through, green. That is the defect this parameter exists for.
 *
 * This file pins BOTH halves: the default is unchanged for the eight suites that pass
 * nothing, and passing 3 catches a three-word parrot the default lets through. Every
 * negative below is paired with the positive that proves the check was alive.
 */

let dir;
let skillPath;

/** A skill that teaches a short phrase and shows a short example clause — the shape the
 * default was tuned to protect, and the shape this parameter has to be able to see. */
const SKILL = [
  '# A skill',
  '',
  'Some of the range:',
  '',
  '> Third one in the last day.',
  '',
  '> Short notice on that one, by the look of it.',
  '',
].join('\n');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'variation-test-'));
  skillPath = join(dir, 'skill.md');
  await writeFile(skillPath, SKILL, 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('skillSampleSentences', () => {
  it('still drops anything under seven words when nothing is passed', async () => {
    expect(DEFAULT_MIN_SAMPLE_WORDS).toBe(7);
    const samples = await skillSampleSentences(skillPath);
    // The positive control: the nine-word example IS harvested, so a suite that passes
    // nothing still has a working parrot gate and this is not an empty-set test.
    expect(samples).toContain('short notice on that one by the look of it');
    expect(samples).not.toContain('third one in the last day');
  });

  it('harvests the short example when the caller asks for a shorter floor', async () => {
    const samples = await skillSampleSentences(skillPath, { minSampleWords: 3 });
    expect(samples).toContain('third one in the last day');
    expect(samples).toContain('short notice on that one by the look of it');
  });
});

describe('variationGate', () => {
  /** Three distinct clauses, one of which is the skill's own example word for word. */
  const items = [
    { id: 'parrot', text: 'Third one in the last day.' },
    { id: 'b', text: 'Busy stretch over there.' },
    { id: 'c', text: 'Quiet week until then.' },
  ];
  const samples = ['third one in the last day'];

  it('lets a three-word-class parrot through at the default floor', async () => {
    const report = variationGate({ items, samples });
    expect(report.failuresById.parrot).toBeUndefined();
  });

  it('catches the same parrot at minSampleWords 3', async () => {
    const report = variationGate({ items, samples, minSampleWords: 3 });
    expect(report.failuresById.parrot?.join(' ')).toMatch(/parrots_skill_sample/);
    // Paired positive control: the two clauses that are NOT the skill's line stay clean,
    // so the lower floor has not simply started failing everything.
    expect(report.failuresById.b).toBeUndefined();
    expect(report.failuresById.c).toBeUndefined();
  });

  it('leaves the pairwise and edge checks exactly where they were', async () => {
    // Neither of those has a word-count condition, so lowering the floor must not move
    // them - the distinction the brief's own critique turned on.
    const atDefault = variationGate({ items, minDistinctOpeners: 3, minDistinctClosers: 3 });
    const lowered = variationGate({
      items,
      minSampleWords: 3,
      minDistinctOpeners: 3,
      minDistinctClosers: 3,
    });
    expect(lowered.worstPair).toEqual(atDefault.worstPair);
    expect(lowered.distinctOpeners).toBe(atDefault.distinctOpeners);
    expect(lowered.distinctClosers).toBe(atDefault.distinctClosers);
    expect(lowered.passed).toBe(atDefault.passed);
  });
});
