import { describe, expect, it } from 'vitest';
import { deidentifyActivityQuery } from './deidentify';
import { groundUserMessage } from './lane';
import { activityPlaceOf, activityPlaceOfPostal } from './place';

const row = (fields: {
  country?: string | null;
  province?: string | null;
  city?: string | null;
  postalCode?: string | null;
  areaCoarse?: string | null;
}) => ({
  country: null,
  province: null,
  city: null,
  postalCode: null,
  areaCoarse: null,
  ...fields,
});

describe('activityPlaceOf — the town a find searches, for US and Canadian families', () => {
  it('a Seattle ZIP searches Seattle, Washington, United States', async () => {
    expect(await activityPlaceOf(row({ country: 'United States', postalCode: '98101' }))).toEqual({
      status: 'known',
      town: 'Seattle, Washington, United States',
    });
  });

  it('a Calgary FSA searches Calgary, Alberta, Canada', async () => {
    expect(await activityPlaceOf(row({ country: 'Canada', postalCode: 'T3A' }))).toEqual({
      status: 'known',
      town: 'Calgary, Alberta, Canada',
    });
  });

  it('a GTA FSA keeps its municipality, spelled as the town label', async () => {
    expect(await activityPlaceOf(row({ country: 'Canada', areaCoarse: 'L7G' }))).toEqual({
      status: 'known',
      town: 'Halton Hills',
    });
    expect(await activityPlaceOf(row({ country: 'Canada', areaCoarse: 'L4A' }))).toEqual({
      status: 'known',
      town: 'Stouffville',
    });
  });

  it('a town of fewer than 10,000 people searches as the nearest larger one', async () => {
    expect(await activityPlaceOf(row({ country: 'United States', postalCode: '62214' }))).toEqual({
      status: 'known',
      town: 'Centralia, Illinois, United States',
    });
  });

  it('a place of 10,000 or more is searched as itself (positive control)', async () => {
    expect(await activityPlaceOf(row({ country: 'United States', postalCode: '60101' }))).toEqual({
      status: 'known',
      town: 'Addison, Illinois, United States',
    });
  });

  it('a stored city with no postal code is searched by its checked-in spelling', async () => {
    expect(
      await activityPlaceOf(row({ country: 'United States', province: 'WA', city: 'seattle' })),
    ).toEqual({ status: 'known', town: 'Seattle, United States' });
  });

  it('no resolvable place is a named reason, never a placeless town', async () => {
    expect(await activityPlaceOf(row({}))).toEqual({ status: 'unknown', reason: 'no_country' });
    expect(await activityPlaceOf(row({ country: 'Canada' }))).toEqual({
      status: 'unknown',
      reason: 'no_postal',
    });
    // A US area_coarse is the ZIP3, which names no city.
    expect(await activityPlaceOf(row({ country: 'United States', areaCoarse: '981' }))).toEqual({
      status: 'unknown',
      reason: 'unmapped',
    });
  });

  it('a postal token is placed by its own country', async () => {
    expect(await activityPlaceOfPostal('98101-1234')).toEqual({
      status: 'known',
      town: 'Seattle, Washington, United States',
    });
    expect(await activityPlaceOfPostal('T3A')).toEqual({
      status: 'known',
      town: 'Calgary, Alberta, Canada',
    });
    expect(await activityPlaceOfPostal('SW1A')).toEqual({
      status: 'unknown',
      reason: 'unsupported_country',
    });
  });

  it('no search payload carries the postal code or ZIP it was placed from', async () => {
    for (const [country, postalCode] of [
      ['United States', '98101'],
      ['Canada', 'T3A'],
      ['Canada', 'L7G'],
    ] as const) {
      const place = await activityPlaceOf(row({ country, postalCode }));
      if (place.status !== 'known') throw new Error(`unplaced ${postalCode}`);
      const query = deidentifyActivityQuery({
        subject: 'toddler gymnastics',
        town: place.town,
        stage: 'toddler',
        householdNames: [],
      });
      if (!query.ok) throw new Error(query.refusal);
      const sent = groundUserMessage(query.query);
      expect(sent).toContain(place.town);
      expect(sent).not.toMatch(/\d{5}|[A-Z]\d[A-Z]/i);
    }
  });
});
