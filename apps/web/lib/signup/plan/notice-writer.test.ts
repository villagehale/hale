import { afterEach, describe, expect, it, vi } from 'vitest';
import { keptCard, loginCardViolations } from './notice-writer';
import type { PlanPrepFacts } from './prep';

// Invented host and child. The words are what a model might return; the gate is code.
const HOST = 'register.example-rec.test';
const FACTS: PlanPrepFacts = {
  kind: 'login_ask',
  childFirstName: 'Ada',
  opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
  host: HOST,
  language: 'zh',
  sessionLabel: 'Preschool Swim Sat 9:00',
  loginCard: {
    sessionLabel: 'Preschool Swim Sat 9:00',
    opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the login card preview the notice writer returns', () => {
  it('keeps words that say only the card facts, the provider host included', () => {
    expect(
      keptCard(
        { title: `${HOST} 的登录`, description: '周六 9:00 游泳课 · 12月1日 7:00 开放报名' },
        FACTS,
      ),
    ).toEqual({
      title: `${HOST} 的登录`,
      description: '周六 9:00 游泳课 · 12月1日 7:00 开放报名',
    });
  });

  it('refuses the child name, a price, a clock the facts do not hold, and any other link', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(loginCardViolations({ title: 'Login for Ada', description: null }, FACTS)).toEqual([
      'title: names the child',
    ]);
    expect(loginCardViolations({ title: 'Login', description: '$98 a month' }, FACTS)).toEqual([
      'description: a price',
    ]);
    expect(loginCardViolations({ title: 'Login', description: 'opens 8:00' }, FACTS)).toEqual([
      'description: a time that is not in the card facts',
    ]);
    expect(loginCardViolations({ title: 'Login at evil.app', description: null }, FACTS)).toEqual([
      'title: contains a link',
    ]);
    expect(loginCardViolations({ title: ' ', description: null }, FACTS)).toEqual(['empty title']);
    expect(keptCard({ title: 'Login for ADA', description: '' }, FACTS)).toBeNull();
    expect(JSON.stringify(info.mock.calls)).toContain('card_refused');
    // Positive controls: a word that only contains the name, and a clock the facts hold.
    expect(
      loginCardViolations({ title: 'Canada swim login', description: 'opens 7:00' }, FACTS),
    ).toEqual([]);
  });

  it('writes no card when the notice carries none, and names a card it could not read', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(keptCard({ title: 'Login', description: 'Swim' }, { ...FACTS, loginCard: null })).toBe(
      null,
    );
    expect(info).not.toHaveBeenCalled();
    expect(keptCard({ title: 'Login' }, FACTS)).toBeNull();
    expect(keptCard(undefined, FACTS)).toBeNull();
    expect(JSON.stringify(info.mock.calls)).toContain('card_unwritten');
    expect(keptCard({ title: 'Login', description: '  ' }, FACTS)).toEqual({
      title: 'Login',
      description: null,
    });
  });

  it('never lets a passed open back in: with no open in the card facts, no clock goes', () => {
    const passed: PlanPrepFacts = {
      ...FACTS,
      kind: 'password_rejected',
      loginCard: { sessionLabel: 'Preschool Swim', opensAt: null },
    };
    expect(loginCardViolations({ title: 'New link', description: 'opens 7:00' }, passed)).toEqual([
      'description: a time that is not in the card facts',
    ]);
  });
});
