import { describe, expect, it } from 'vitest';
import { coachHelpLines } from './coach-help-lines.mjs';

describe('coachHelpLines: a fixture row gets the lines production would hand it (VIL-589)', () => {
  it('an Ontario fixture carries 811 and 911; a US fixture and any group turn carry no 811', async () => {
    const said = async (location, audience) =>
      JSON.stringify(await coachHelpLines(location, audience));

    const ontario = await said({ province: 'ON', country: 'CA' });
    expect(ontario).toMatch(/\b811\b/);
    expect(ontario).toMatch(/\b911\b/);
    for (const elsewhere of [
      await said({ province: 'OH', country: 'US' }),
      await said({ province: 'ON', country: 'CA' }, 'group'),
    ]) {
      expect(elsewhere).not.toMatch(/811/);
      expect(elsewhere).toMatch(/\b911\b/);
    }
  });
});
