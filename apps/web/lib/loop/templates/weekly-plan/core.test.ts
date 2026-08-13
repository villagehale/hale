import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { isGsm7 } from '~/lib/channel/sms-segments';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import {
  childrenInPlan,
  dayAbbrev,
  genericSensitiveWhat,
  gsmSafe,
  headerNames,
  itemsChronological,
  leveledWhat,
  partitionByNeed,
  pendingCount,
  provenanceLabel,
  strippedWhat,
  timeLabel,
  weekRangeLabel,
  weekSubject,
} from './core';
import type { PlanChild } from './payload';

/**
 * VIL-218 · B2 weekly_plan renderer — the pure helpers. Deterministic (no LLM, no
 * DB); every expected value is derived from the spec (the GSM/UCS-2 concatenation
 * math, the deriveStage teen gate, the copy rules), never copied from output.
 */

// deriveStage boundaries are [12, 48, 156] months; NOW anchors every age.
const NOW = new Date('2026-07-20T12:00:00Z');
const EM_DASH = '—';

const maya: PlanChild = { id: 'c-maya', name: 'Maya', dateOfBirth: '2019-03-10', gender: 'girl' };
const liam: PlanChild = { id: 'c-liam', name: 'Liam', dateOfBirth: '2021-06-01', gender: 'boy' };
const ada: PlanChild = { id: 'c-ada', name: 'Ada', dateOfBirth: '2023-01-01', gender: 'girl' };
// 2011 DOB is ~15y at NOW → deriveStage 'teenager' → the age gate forces generic.
const teen: PlanChild = { id: 'c-teen', name: 'Sam', dateOfBirth: '2011-01-01', gender: 'boy' };

function item(partial: Partial<WeekPlanItem>): WeekPlanItem {
  return {
    kind: 'village',
    title: 'Something',
    childIds: [],
    startsAt: null,
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
    ...partial,
  };
}

describe('gsmSafe normalizes SMS copy into the GSM-7 alphabet', () => {
  it('maps typographic punctuation to GSM equivalents', () => {
    expect(gsmSafe(`a ${EM_DASH} b`)).toBe('a - b');
    expect(gsmSafe('a · b')).toBe('a - b');
    expect(gsmSafe('it’s')).toBe("it's");
    expect(gsmSafe('wait…')).toBe('wait...');
  });

  it('strips emoji and leaves GSM-encodable text', () => {
    const out = gsmSafe('Park meetup \u{1f389} today');
    expect(out).toBe('Park meetup today');
    expect(isGsm7(out)).toBe(true);
  });

  it('transliterates an accent GSM-7 cannot carry rather than deleting the letter', () => {
    // A name is the one thing in an SMS that must survive recognizably: "Loc" is not
    // Loïc, and this product's compliance baseline is Quebec.
    expect(gsmSafe('Loïc has swim class')).toBe('Loic has swim class');
    expect(gsmSafe('François - leçon de natation')).toBe('Francois - lecon de natation');
    expect(gsmSafe('Noël with Ève')).toBe('Noel with Eve');
  });

  it('leaves the accents GSM-7 does carry exactly as written', () => {
    expect(gsmSafe('Chloé & Zoé à Québec')).toBe('Chloé & Zoé à Québec');
    expect(isGsm7(gsmSafe('Chloé & Zoé à Québec'))).toBe(true);
  });
});

describe('gsmSafe folds against the same table the carrier is billed on', () => {
  /** One table, in ~/lib/channel/sms-segments (which pins its contents against GSM
   * 03.38). This module kept a second copy and the two had already diverged on form
   * feed — copy folded against one alphabet and billed against the other is how a
   * "3 segments" budget quietly becomes five. What is asserted here is the property
   * that made the drift matter: whatever gsmSafe emits, the encoder that bills it
   * agrees it is GSM-7. A second private notion of "safe" fails this. */
  const CORPUS = [
    'Hale \u2014 your week',
    'it\u2019s Lo\u00efc\u2019s turn',
    'Park meetup \u{1f389}',
    'Fran\u00e7ois \u00b7 le\u00e7on de natation',
    'Caf\u00e9 \u00a35 \u00e0 Montr\u00e9al',
    'No\u00ebl with \u00c8ve',
    '\f\f\f',
    'wait\u2026 \u20ac5',
  ];

  it.each(CORPUS)('folds %j into a body the encoder bills as GSM-7', (raw) => {
    expect(isGsm7(gsmSafe(raw))).toBe(true);
  });
});

describe('headerNames — child naming at each level (teen gate composed)', () => {
  it('single child renders its leveled name', () => {
    expect(headerNames([maya], 'first_name', NOW)).toBe('Maya');
    expect(headerNames([maya], 'relation', NOW)).toBe('your daughter');
    expect(headerNames([liam], 'relation', NOW)).toBe('your son');
    expect(headerNames([maya], 'generic', NOW)).toBe('your kid');
  });

  it('a teen is never named — forced to "your teen" at every level', () => {
    for (const level of ['first_name', 'relation', 'generic'] as ChildNameLevel[]) {
      expect(headerNames([teen], level, NOW)).toBe('your teen');
    }
  });

  it('multiple distinct first names join with & (2 and 3+)', () => {
    expect(headerNames([maya, liam], 'first_name', NOW)).toBe('Maya & Liam');
    expect(headerNames([maya, liam, ada], 'first_name', NOW)).toBe('Maya, Liam & Ada');
  });

  it('multiple children at relation/generic collapse to "your kids"', () => {
    expect(headerNames([maya, liam], 'relation', NOW)).toBe('your kids');
    expect(headerNames([maya, liam], 'generic', NOW)).toBe('your kids');
  });

  it('a teen anywhere in a multi set forces "your kids" even at first_name', () => {
    expect(headerNames([maya, teen], 'first_name', NOW)).toBe('your kids');
  });

  it('no children in the plan → null (the "Your" sentinel)', () => {
    expect(headerNames([], 'first_name', NOW)).toBeNull();
  });
});

describe('weekSubject — possessive of the header names', () => {
  it('null names → "Your"; a name → "’s"; a name ending in s → "’"', () => {
    expect(weekSubject(null)).toBe('Your');
    expect(weekSubject('Maya')).toBe("Maya's");
    expect(weekSubject('Maya & Liam')).toBe("Maya & Liam's");
    expect(weekSubject('your kid')).toBe("your kid's");
    expect(weekSubject('your kids')).toBe("your kids'");
    expect(weekSubject('your teen')).toBe("your teen's");
  });
});

describe('pendingCount — items that ask something of the parent', () => {
  it('counts needs !== "none"', () => {
    const items = [
      item({ needs: 'none' }),
      item({ needs: 'calendar_add' }),
      item({ needs: 'decision' }),
    ];
    expect(pendingCount(items)).toBe(2);
    expect(pendingCount([])).toBe(0);
  });
});

describe('partitionByNeed — decision-needed vs handled', () => {
  it('splits pending (needs !== none) from handled, preserving order', () => {
    const a = item({ title: 'a', needs: 'calendar_add' });
    const b = item({ title: 'b', needs: 'none' });
    const c = item({ title: 'c', needs: 'decision' });
    const d = item({ title: 'd', needs: 'none' });
    const { pending, handled } = partitionByNeed([a, b, c, d]);
    expect(pending.map((i) => i.title)).toEqual(['a', 'c']);
    expect(handled.map((i) => i.title)).toEqual(['b', 'd']);
  });
});

describe('weekRangeLabel — the Mon–Sun header kicker', () => {
  it('shows a bare end day within one month', () => {
    // 2026-07-20 (Mon) → 2026-07-26 (Sun).
    expect(weekRangeLabel('2026-07-20')).toBe('Jul 20 – 26');
  });

  it('names the second month when the week crosses one', () => {
    // 2026-07-27 (Mon) → 2026-08-02 (Sun).
    expect(weekRangeLabel('2026-07-27')).toBe('Jul 27 – Aug 2');
  });

  it('reads the date at UTC (a time suffix does not shift the day)', () => {
    expect(weekRangeLabel('2026-12-28T00:00')).toBe('Dec 28 – Jan 3');
  });
});

describe('provenanceLabel — the chip for each kind', () => {
  it('labels every kind', () => {
    expect(provenanceLabel('appointment')).toBe('Health');
    expect(provenanceLabel('routine')).toBe('Routine');
    expect(provenanceLabel('village')).toBe('Village');
    expect(provenanceLabel('birthday')).toBe('Birthday');
    expect(provenanceLabel('suggestion')).toBe('Suggestion');
  });
});

describe('dayAbbrev / timeLabel — from the family-local ISO string', () => {
  it('dayAbbrev maps a date key to its weekday, null when undated', () => {
    // 2026-07-20 is a Monday; +1 day Tuesday.
    expect(dayAbbrev('2026-07-20')).toBe('Mon');
    expect(dayAbbrev('2026-07-21T16:30')).toBe('Tue');
    expect(dayAbbrev('2026-07-26')).toBe('Sun');
    expect(dayAbbrev(null)).toBeNull();
  });

  it('timeLabel formats HH:MM as 12-hour, null when day-coarse', () => {
    expect(timeLabel('2026-07-20T16:30')).toBe('4:30');
    expect(timeLabel('2026-07-20T09:05')).toBe('9:05');
    expect(timeLabel('2026-07-20T00:00')).toBe('12:00');
    expect(timeLabel('2026-07-20')).toBeNull();
    expect(timeLabel(null)).toBeNull();
  });
});

describe('itemsChronological — dated ascending, undated last', () => {
  it('sorts by the ISO start key, null sinks to the end', () => {
    const a = item({ title: 'wed', startsAt: '2026-07-22' });
    const b = item({ title: 'mon', startsAt: '2026-07-20T10:30' });
    const c = item({ title: 'undated', startsAt: null });
    const d = item({ title: 'tue', startsAt: '2026-07-21T16:30' });
    expect(itemsChronological([a, b, c, d]).map((i) => i.title)).toEqual([
      'mon',
      'tue',
      'wed',
      'undated',
    ]);
  });
});

describe('genericSensitiveWhat — health detail never rides SMS/push', () => {
  it('genericizes an appointment to "a checkup", else "an appointment"', () => {
    expect(genericSensitiveWhat(item({ kind: 'appointment' }))).toBe('a checkup');
    expect(genericSensitiveWhat(item({ kind: 'birthday' }))).toBe('an appointment');
  });
});

describe('strippedWhat — the header already names the child', () => {
  it('drops the baked first name (em-dash and possessive forms)', () => {
    const appt = item({ title: `Maya ${EM_DASH} 6-month checkup`, childIds: ['c-maya'] });
    expect(strippedWhat(appt, [maya])).toBe('6-month checkup');
    const bday = item({ title: "Maya's birthday", childIds: ['c-maya'] });
    expect(strippedWhat(bday, [maya])).toBe('birthday');
  });

  it('leaves a nameless item untouched', () => {
    const v = item({ title: 'Library storytime' });
    expect(strippedWhat(v, [maya])).toBe('Library storytime');
  });
});

describe('leveledWhat — re-level the baked first name to the parent dial', () => {
  const appt = item({ title: `Maya ${EM_DASH} 6-month checkup`, childIds: ['c-maya'] });

  it('first_name keeps the name; relation/generic replace it', () => {
    expect(leveledWhat(appt, [maya], 'first_name', NOW)).toBe(`Maya ${EM_DASH} 6-month checkup`);
    expect(leveledWhat(appt, [maya], 'relation', NOW)).toBe(
      `your daughter ${EM_DASH} 6-month checkup`,
    );
    expect(leveledWhat(appt, [maya], 'generic', NOW)).toBe(`your kid ${EM_DASH} 6-month checkup`);
  });

  it('a teen item (already generic in the artifact) never surfaces a name', () => {
    const teenAppt = item({
      title: 'a private appointment for your teen',
      childIds: ['c-teen'],
      privacySensitive: true,
    });
    for (const level of ['first_name', 'relation', 'generic'] as ChildNameLevel[]) {
      const out = leveledWhat(teenAppt, [teen], level, NOW);
      expect(out).toBe('a private appointment for your teen');
      expect(out).not.toContain('Sam');
    }
  });
});

describe('childrenInPlan — only children an item references', () => {
  it('filters to referenced ids, preserving order', () => {
    const items = [item({ childIds: ['c-liam'] }), item({ childIds: [] })];
    expect(childrenInPlan(items, [maya, liam, ada]).map((c) => c.id)).toEqual(['c-liam']);
    expect(childrenInPlan([item({ childIds: [] })], [maya, liam])).toEqual([]);
  });
});
