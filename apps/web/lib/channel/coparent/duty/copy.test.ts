import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_COPY_LOCKED_ENV,
  DUTY_BOTH_CLAIMED_COPY,
  DUTY_BOTH_CLAIMED_COPY_FR,
  DUTY_COPY_TEMPLATES,
  DUTY_NIGHT_BEFORE_COPY_EN,
  DUTY_NIGHT_BEFORE_COPY_FR,
  DUTY_PARENT_ASK_COPY_EN,
  DUTY_PARENT_ASK_COPY_FR,
  DUTY_PARENT_OWNED_COPY_EN,
  DUTY_PARENT_OWNED_COPY_FR,
  DUTY_REASK_COPY_EN,
  DUTY_REASK_COPY_FR,
  DUTY_SILENT_PARENT_COPY_EN,
  DUTY_SILENT_PARENT_COPY_FR,
  DUTY_WEEK_OVERVIEW_COPY_EN,
  DUTY_WEEK_OVERVIEW_COPY_FR,
  DUTY_WEEK_OWNED_ITEM,
  DUTY_WEEK_UNOWNED_ITEM_EN,
  DUTY_WEEK_UNOWNED_ITEM_FR,
  DUTY_WHICH_KID_COPY,
  DUTY_WHICH_KID_COPY_FR,
  DutyCopyError,
  absorbDutyLine,
  dutyClockLabel,
  dutyCopy,
  dutyCopyLocked,
  dutyCopyMayLeave,
  dutyWeekList,
  dutyWeekdayName,
  formatDutyKids,
  spokenFirstName,
} from './copy';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx|mjs|sql|md)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

const OWNED = {
  name: 'Sam',
  kid: 'Maya',
  event: 'swim',
  day: 'Monday',
  time: '3:00pm',
};

describe('duty copy lock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays unlocked unless the value is exactly true', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, '');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'TRUE');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true\n');
    expect(dutyCopyLocked()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    expect(dutyCopyLocked()).toBe(true);
  });

  it('does not let an unrendered template leave, even when the lock flag is on', () => {
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    for (const line of DUTY_COPY_TEMPLATES) {
      expect(line.includes('TODO-Design')).toBe(false);
      expect(dutyCopyMayLeave(line)).toBe(false);
    }
    expect(dutyCopyMayLeave('TODO-Design: which kid?')).toBe(false);
    expect(absorbDutyLine('This week: swim.', DUTY_NIGHT_BEFORE_COPY_EN)).toBe('This week: swim.');
    expect(absorbDutyLine('This week: swim.', 'Sam is booked for swim.')).toBe('This week: swim.');
  });

  it('keeps the locked templates in copy.ts and the placeholder marker only in the send guard', () => {
    const copyPath = fileURLToPath(new URL('./copy.ts', import.meta.url));
    const copy = readFileSync(copyPath, 'utf8');
    const asideFromGuard = copy.replace("text.includes('TODO-Design')", '');
    expect(asideFromGuard).not.toContain('TODO-Design');
    for (const line of DUTY_COPY_TEMPLATES) {
      expect(copy).toContain(line);
    }
    const roots = [join(ROOT, 'apps'), join(ROOT, 'packages')];
    const leaks: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        if (file === copyPath || file.endsWith('copy.test.ts')) continue;
        const source = readFileSync(file, 'utf8');
        if (source.includes('TODO-Design: who is on what this week')) {
          leaks.push(file.slice(ROOT.length));
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('renders each locked sentence byte for byte', () => {
    expect(dutyCopy('week_overview', 'en', { list: 'Monday swim (Sam)' })).toBe(
      'Who has what this week: Monday swim (Sam).',
    );
    expect(dutyCopy('week_overview', 'fr', { list: 'lundi natation (Sam)' })).toBe(
      "Qui s'occupe de quoi cette semaine: lundi natation (Sam).",
    );
    expect(dutyCopy('parent_initiated', 'en', OWNED)).toBe(
      "Sam has Maya's swim, Monday at 3:00pm.",
    );
    expect(
      dutyCopy('parent_initiated', 'fr', {
        name: 'Sam',
        kid: 'Maya',
        event: 'natation',
        day: 'lundi',
        time: '15:00',
      }),
    ).toBe("Sam s'occupe de natation pour Maya, lundi a 15:00.");
    expect(
      dutyCopy('parent_initiated', 'en', {
        kid: 'Maya',
        event: 'swim',
        day: 'Monday',
        time: '3:00pm',
      }),
    ).toBe("Nobody has Maya's swim, Monday at 3:00pm yet. Who's taking it?");
    expect(
      dutyCopy('parent_initiated', 'fr', {
        kid: 'Maya',
        event: 'natation',
        day: 'lundi',
        time: '15:00',
      }),
    ).toBe("Personne ne s'occupe encore de natation pour Maya, lundi a 15:00. Qui le prend?");
    expect(dutyCopy('which_kid', 'en', { name: 'Sam', kids: 'Maya, Leo, or both' })).toBe(
      'Sam, got it. Which kid is that for: Maya, Leo, or both?',
    );
    expect(dutyCopy('which_kid', 'fr', { name: 'Sam', kids: 'Maya, Leo, ou les deux' })).toBe(
      "Sam, note. C'est pour quel enfant: Maya, Leo, ou les deux?",
    );
    expect(
      dutyCopy('both_claimed', 'en', {
        event: 'swim',
        day: 'Monday',
        parentA: 'Sam',
        parentB: 'Barton',
      }),
    ).toBe("You both said you've got swim, Monday. Who's taking it, Sam or Barton?");
    expect(
      dutyCopy('both_claimed', 'fr', {
        event: 'natation',
        day: 'lundi',
        parentA: 'Sam',
        parentB: 'Barton',
      }),
    ).toBe(
      "Vous avez dit tous les deux que vous vous en occupez pour natation, lundi. C'est Sam ou Barton?",
    );
    expect(dutyCopy('reask_48h', 'en', OWNED)).toBe(
      "Still nobody on Maya's swim, Monday at 3:00pm. Who's taking it?",
    );
    expect(
      dutyCopy('reask_48h', 'fr', { kid: 'Maya', event: 'natation', day: 'lundi', time: '15:00' }),
    ).toBe("Toujours personne pour s'occuper de natation pour Maya, lundi a 15:00. Qui le prend?");
    expect(dutyCopy('night_before', 'en', OWNED)).toBe(
      "Tomorrow: Sam has Maya's swim at 3:00pm. Say so here if that changes.",
    );
    expect(
      dutyCopy('night_before', 'fr', {
        name: 'Sam',
        kid: 'Maya',
        event: 'natation',
        time: '15:00',
      }),
    ).toBe("Demain: Sam s'occupe de natation pour Maya a 15:00. Dites-le ici si ca change.");
    expect(dutyCopy('silent_parent', 'en', { name: 'Barton', event: 'swim', day: 'Monday' })).toBe(
      'Barton, over to you on swim, Monday.',
    );
    expect(
      dutyCopy('silent_parent', 'fr', { name: 'Barton', event: 'natation', day: 'lundi' }),
    ).toBe('Barton, a toi de nous dire pour natation, lundi.');
  });

  it('refuses a missing token instead of leaving braces in the sentence', () => {
    expect(() => dutyCopy('night_before', 'en', { name: 'Sam' })).toThrow(DutyCopyError);
    expect(() => dutyCopy('which_kid', 'en', { name: 'Sam' })).toThrow(DutyCopyError);
    expect(() => dutyCopy('week_overview', 'en', {})).toThrow(DutyCopyError);
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const ready = dutyCopy('silent_parent', 'en', { name: 'Sam', event: 'swim', day: 'Monday' });
    expect(ready).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(dutyCopyMayLeave(ready)).toBe(true);
    expect(absorbDutyLine('Sunday.', ready)).toBe(`Sunday.\n${ready}`);
  });

  it('builds the week list and the which-kid roster without inventing a name', () => {
    expect(
      dutyWeekList('en', [
        { day: 'Monday', event: 'swim', name: 'Sam' },
        { day: 'Tuesday', event: 'piano', name: null },
      ]),
    ).toBe('Monday swim (Sam); Tuesday piano (nobody yet)');
    expect(dutyWeekList('fr', [{ day: 'lundi', event: 'natation', name: null }])).toBe(
      "lundi natation (personne pour l'instant)",
    );
    expect(formatDutyKids(['Maya', 'Leo'], 'en')).toBe('Maya, Leo, or both');
    expect(formatDutyKids(['Maya', 'Leo'], 'fr')).toBe('Maya, Leo, ou les deux');
    expect(formatDutyKids(['Maya'], 'en')).toBeNull();
    expect(spokenFirstName('Sam Rivera')).toBe('Sam');
    expect(spokenFirstName('+14165550100')).toBeNull();
    expect(spokenFirstName(null)).toBeNull();
  });

  it('keeps French ASCII and does not claim a booking', () => {
    const french = DUTY_COPY_TEMPLATES.filter((line) => /[àâäéèêëïîôùûüç]/i.test(line));
    expect(french).toEqual([]);
    for (const line of DUTY_COPY_TEMPLATES) {
      expect([...line].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
      expect(line).not.toMatch(/\b(booked|enrolled|signed up)\b/i);
    }
    expect(DUTY_WHICH_KID_COPY_FR.startsWith('{name}, ')).toBe(true);
    expect(DUTY_SILENT_PARENT_COPY_FR).toContain('a toi');
    expect(DUTY_BOTH_CLAIMED_COPY_FR.startsWith('Vous')).toBe(true);
    const monday = new Date('2026-09-28T19:00:00.000Z');
    expect(dutyWeekdayName(monday, 'America/Toronto', 'en')).toBe('Monday');
    expect(dutyWeekdayName(monday, 'America/Toronto', 'fr')).toBe('lundi');
    expect(dutyClockLabel(monday, 'America/Toronto', 'en')).toBe('3:00pm');
    expect(dutyClockLabel(monday, 'America/Toronto', 'fr')).toBe('15:00');
    expect(DUTY_WEEK_OVERVIEW_COPY_EN).toBe('Who has what this week: {list}.');
    expect(DUTY_WEEK_OVERVIEW_COPY_FR).toBe("Qui s'occupe de quoi cette semaine: {list}.");
    expect(DUTY_PARENT_OWNED_COPY_EN).toBe("{name} has {kid}'s {event}, {day} at {time}.");
    expect(DUTY_PARENT_OWNED_COPY_FR).toBe(
      "{name} s'occupe de {event} pour {kid}, {day} a {time}.",
    );
    expect(DUTY_PARENT_ASK_COPY_EN).toBe(
      "Nobody has {kid}'s {event}, {day} at {time} yet. Who's taking it?",
    );
    expect(DUTY_PARENT_ASK_COPY_FR).toBe(
      "Personne ne s'occupe encore de {event} pour {kid}, {day} a {time}. Qui le prend?",
    );
    expect(DUTY_WHICH_KID_COPY).toBe('{name}, got it. Which kid is that for: {kids}?');
    expect(DUTY_WHICH_KID_COPY_FR).toBe("{name}, note. C'est pour quel enfant: {kids}?");
    expect(DUTY_BOTH_CLAIMED_COPY).toBe(
      "You both said you've got {event}, {day}. Who's taking it, {parentA} or {parentB}?",
    );
    expect(DUTY_BOTH_CLAIMED_COPY_FR).toBe(
      "Vous avez dit tous les deux que vous vous en occupez pour {event}, {day}. C'est {parentA} ou {parentB}?",
    );
    expect(DUTY_REASK_COPY_EN).toBe(
      "Still nobody on {kid}'s {event}, {day} at {time}. Who's taking it?",
    );
    expect(DUTY_REASK_COPY_FR).toBe(
      "Toujours personne pour s'occuper de {event} pour {kid}, {day} a {time}. Qui le prend?",
    );
    expect(DUTY_NIGHT_BEFORE_COPY_EN).toBe(
      "Tomorrow: {name} has {kid}'s {event} at {time}. Say so here if that changes.",
    );
    expect(DUTY_NIGHT_BEFORE_COPY_FR).toBe(
      "Demain: {name} s'occupe de {event} pour {kid} a {time}. Dites-le ici si ca change.",
    );
    expect(DUTY_SILENT_PARENT_COPY_EN).toBe('{name}, over to you on {event}, {day}.');
    expect(DUTY_SILENT_PARENT_COPY_FR).toBe('{name}, a toi de nous dire pour {event}, {day}.');
    expect(DUTY_WEEK_OWNED_ITEM).toBe('{day} {event} ({name})');
    expect(DUTY_WEEK_UNOWNED_ITEM_EN).toBe('{day} {event} (nobody yet)');
    expect(DUTY_WEEK_UNOWNED_ITEM_FR).toBe("{day} {event} (personne pour l'instant)");
  });
});
