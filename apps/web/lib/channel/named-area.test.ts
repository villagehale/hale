import { describe, expect, it } from 'vitest';
import {
  type NamedArea,
  type NamedAreaReader,
  resolveNamedArea,
  searchableArea,
} from './named-area';

const NAMES = ['Noah', 'Ava'];

const area = (
  granularity: NamedArea['granularity'],
  locality: string | null,
  region: string | null = null,
): NamedArea => ({ granularity, locality, region });

describe('searchableArea: the model names the grain, code holds the line', () => {
  it('searches a real town whose name ends in a street word', () => {
    // The word-list gate refused every one of these as a street.
    for (const [locality, region] of [
      ['Terrace', 'British Columbia'],
      ['Trail', 'British Columbia'],
      ['Federal Way', 'Washington'],
      ['College Place', 'Washington'],
    ] as const) {
      expect(searchableArea(area('locality', locality, region), NAMES)).toEqual({
        ok: true,
        area: { locality, region },
        label: `${locality}, ${region}`,
      });
    }
  });

  it('keeps a saint abbreviation in front of the town', () => {
    expect(searchableArea(area('locality', 'St. Catharines', 'Ontario'), NAMES)).toMatchObject({
      ok: true,
      label: 'St. Catharines, Ontario',
    });
  });

  it('refuses a street the model called a street, whatever town came with it', () => {
    // Positive control above: the same locality shape passes when the grain is a town.
    for (const named of [
      area('street', 'Bayview Drive', 'Ontario'),
      area('street', 'Wallace St', 'British Columbia'),
      area('street', 'Terrace', 'British Columbia'),
    ]) {
      expect(searchableArea(named, NAMES)).toEqual({ ok: false, refusal: 'area_unusable' });
    }
  });

  it('refuses something that is not a place', () => {
    expect(searchableArea(area('not_a_place', null), NAMES)).toEqual({
      ok: false,
      refusal: 'area_unusable',
    });
  });

  it('refuses a digit anywhere, so no house number, postal code or ZIP crosses', () => {
    for (const named of [
      area('locality', 'Federal Way 98003', 'Washington'),
      area('locality', 'Terrace', 'V8G'),
      area('locality', '42 Terrace', null),
      area('region', null, 'Washington 98'),
    ]) {
      expect(searchableArea(named, NAMES)).toEqual({ ok: false, refusal: 'area_unusable' });
    }
  });

  it('refuses a field that carries a second field after a comma or other punctuation', () => {
    for (const named of [
      area('locality', 'Terrace, Main St', 'British Columbia'),
      area('locality', 'Terrace', 'BC / near the arena'),
      area('locality', 'someone@example.com', null),
    ]) {
      expect(searchableArea(named, NAMES)).toEqual({ ok: false, refusal: 'area_unusable' });
    }
  });

  it('refuses a place that names someone in the household, in either field', () => {
    expect(searchableArea(area('locality', 'Noah', null), NAMES)).toEqual({
      ok: false,
      refusal: 'area_names_a_person',
    });
    expect(searchableArea(area('locality', 'Terrace', 'Ava Ridge'), NAMES)).toEqual({
      ok: false,
      refusal: 'area_names_a_person',
    });
    // Positive control: the same shape with no household name searches.
    expect(searchableArea(area('locality', 'Terrace', 'Ridge'), NAMES).ok).toBe(true);
  });

  it('searches a neighbourhood by the town it is in, and never carries its name', () => {
    expect(searchableArea(area('neighbourhood', 'Spokane', 'Washington'), NAMES)).toEqual({
      ok: true,
      area: { locality: 'Spokane', region: 'Washington' },
      label: 'Spokane, Washington',
    });
    expect(searchableArea(area('neighbourhood', null, 'Washington'), NAMES)).toEqual({
      ok: false,
      refusal: 'area_unusable',
    });
  });

  it('searches a whole province or state, and drops a locality the grain did not name', () => {
    expect(searchableArea(area('region', 'Burlington', 'Vermont'), NAMES)).toEqual({
      ok: true,
      area: { locality: null, region: 'Vermont' },
      label: 'Vermont',
    });
    expect(searchableArea(area('region', null, null), NAMES)).toEqual({
      ok: false,
      refusal: 'area_unusable',
    });
  });

  it('searches a town with no region when the model could not tell which one', () => {
    expect(searchableArea(area('locality', 'Springfield', null), NAMES)).toEqual({
      ok: true,
      area: { locality: 'Springfield', region: null },
      label: 'Springfield',
    });
    expect(searchableArea(area('locality', '  ', null), NAMES)).toEqual({
      ok: false,
      refusal: 'area_unusable',
    });
  });

  it('collapses whitespace and keeps letters from any script', () => {
    expect(searchableArea(area('locality', '  Saint-Jérôme  ', ' Québec '), NAMES)).toEqual({
      ok: true,
      area: { locality: 'Saint-Jérôme', region: 'Québec' },
      label: 'Saint-Jérôme, Québec',
    });
  });
});

describe('resolveNamedArea', () => {
  it('names a failed read as its own outcome, never as a town or a home search', async () => {
    const failed: NamedAreaReader = { read: async () => null };
    await expect(
      resolveNamedArea({ reader: failed, text: 'Terrace BC', householdNames: NAMES }),
    ).resolves.toEqual({
      ok: false,
      refusal: 'area_unread',
    });
  });
});
