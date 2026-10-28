import type { RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import { toRegistrationWindowRow } from '~/lib/registration/registration-windows';
import {
  type RegistrationContextPorts,
  loadRegistrationWindows,
} from './registration-context';

/**
 * The coach's view of the radar. Every fact here is one a parent ACTS on — they set an
 * alarm for 7 a.m. on a workday, or they don't because Hale said it had the morning —
 * so the tests are about what may and may not be claimed, not about the shape.
 */

const NOW = new Date('2026-08-21T12:00:00Z');
const TZ = 'America/Toronto';
/** Georgetown. Resolves to Halton Hills alone, which is what buys the head start. */
const GEORGETOWN = 'L7G';

/** The hand-verified seed row, built through the real parser so the test is reading the
 * dataset the sweep reads and not a hand-copied twin of it. */
function haltonHillsFall(): RegistrationWindow {
  const seed = REGISTRATION_WINDOWS.find(
    (w) => w.municipality === 'halton_hills' && w.cycleLabel === 'Fall 2026',
  );
  if (!seed) throw new Error('the Halton Hills Fall 2026 seed is the fixture; it is gone');
  return { id: 'window-1', ...toRegistrationWindowRow(seed) } as RegistrationWindow;
}

function ports(overrides: Partial<RegistrationContextPorts> = {}): RegistrationContextPorts {
  return {
    areaCoarse: async () => GEORGETOWN,
    childAgesMonths: async () => [17],
    windows: async () => [haltonHillsFall()],
    watching: () => true,
    ...overrides,
  };
}

describe('the coach registration context', () => {
  it("gives the family their OWN date, with the general one named as the later alternative", async () => {
    const [window] = await loadRegistrationWindows(ports(), 'fam-1', TZ, NOW);

    // Published: taxpayers Tuesday September 1 at 7 a.m.; everyone else seven days later.
    expect(window).toMatchObject({
      town: 'Halton Hills',
      programs: 'Fall 2026 recreation programs',
      opensFor: 'Sep 1, 7:00 a.m.',
      residentsFirst: true,
      generalOpens: 'Sep 8, 7:00 a.m.',
      ageApproximate: false,
    });
  });

  it('reports watching exactly as the ladder is armed, in both directions', async () => {
    const [armed] = await loadRegistrationWindows(ports(), 'fam-1', TZ, NOW);
    expect(armed?.watching).toBe(true);

    const [dark] = await loadRegistrationWindows(
      ports({ watching: () => false }),
      'fam-1',
      TZ,
      NOW,
    );
    // The date is still theirs to know; the claim that Hale has the morning is not.
    expect(dark?.opensFor).toBe('Sep 1, 7:00 a.m.');
    expect(dark?.watching).toBe(false);
  });

  it('claims nothing for a family whose area is outside the covered set', async () => {
    // M9J is Etobicoke — a real FSA, not one this window's municipality covers. A
    // neighbouring town's registration morning is worse than silence.
    const outside = await loadRegistrationWindows(
      ports({ areaCoarse: async () => 'M9J' }),
      'fam-1',
      TZ,
      NOW,
    );
    expect(outside).toEqual([]);

    const noArea = await loadRegistrationWindows(
      ports({ areaCoarse: async () => null }),
      'fam-1',
      TZ,
      NOW,
    );
    expect(noArea).toEqual([]);
  });

  it('drops a window whose doors have already opened for this family', async () => {
    const afterOpen = await loadRegistrationWindows(
      ports(),
      'fam-1',
      TZ,
      new Date('2026-09-02T12:00:00Z'),
    );
    expect(afterOpen).toEqual([]);
  });
});
