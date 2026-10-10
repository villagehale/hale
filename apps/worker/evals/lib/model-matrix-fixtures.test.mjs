import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MATRIX_SAMPLE_TARGET,
  expandMatrixCases,
  expandSyntheticFixtures,
} from './model-matrix-fixtures.mjs';

const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'model-matrix');

describe('expanded model-matrix fixtures', () => {
  for (const role of ['classify', 'draft', 'review']) {
    it(`${role} has at least ${MATRIX_SAMPLE_TARGET} unique model-visible samples`, async () => {
      const fixture = JSON.parse(await readFile(join(fixtureDir, `${role}.json`), 'utf8'));
      const cases = expandMatrixCases(role, fixture.cases);
      expect(cases).toHaveLength(MATRIX_SAMPLE_TARGET);
      expect(new Set(cases.map((item) => item.id)).size).toBe(MATRIX_SAMPLE_TARGET);
      expect(new Set(cases.map((item) => item.baseScenarioId)).size).toBe(fixture.cases.length);
    });
  }

  it('keeps distinct names distinct and only replaces whole names', () => {
    const cases = expandSyntheticFixtures(
      'names',
      [{ id: 'family', text: 'Mira and Leo reviewed the sample.' }],
      2,
      {
        vary: (fixture, { reference }) => {
          fixture.text += ` ${reference}`;
        },
        visibleInput: (fixture) => fixture.text,
      },
    );
    expect(cases[1].text).toContain('Avery and Lucas');
    expect(cases[1].text).toContain('sample');
  });
});
