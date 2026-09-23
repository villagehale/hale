import { describe, expect, it } from 'vitest';
import { saturdayPlansFromRows } from './saturday-plans';

describe('saturdayPlansFromRows', () => {
  it('marks a child-attributed event as that child only', () => {
    const plans = saturdayPlansFromRows([{ childId: 'maya' }]);
    expect(plans.householdBusy).toBe(false);
    expect([...plans.busyChildIds]).toEqual(['maya']);
  });

  it('treats a family-wide row or a calendar snapshot as the whole household', () => {
    const plans = saturdayPlansFromRows([{ childId: 'maya' }, { childId: null }]);
    expect(plans.householdBusy).toBe(true);
    expect(plans.busyChildIds.has('maya')).toBe(true);
  });

  it('is open when nothing is on the day', () => {
    expect(saturdayPlansFromRows([])).toEqual({
      householdBusy: false,
      busyChildIds: new Set(),
    });
  });
});
