import { describe, expect, it } from 'vitest';
import { type RootHero, buildRootHeroes, resolveHero } from './hero-map';

const roots = buildRootHeroes({ greeting: 'Good evening, Alex' });

describe('resolveHero', () => {
  it('resolves a tab root to its interpolated hero', () => {
    const res = resolveHero('/home', roots);
    expect(res).toEqual({
      kind: 'root',
      hero: {
        title: 'Good evening, Alex',
        subtitle: "Here's what's happening today.",
        emoji: '👋',
      },
    });
  });

  it('resolves a nested route under a root to that root', () => {
    const res = resolveHero('/settings/privacy', roots);
    expect(res?.kind).toBe('root');
    expect((res?.hero as RootHero).title).toBe('Settings');
  });

  it('does not drill into the retired saved and companion-logs routes', () => {
    expect(resolveHero('/saved', roots)).toBeNull();
    expect(resolveHero('/companion/logs', roots)).toBeNull();
  });

  it('maps messages to a Family breadcrumb + back', () => {
    expect(resolveHero('/messages', roots)).toEqual({
      kind: 'drill',
      hero: { crumb: 'Family', title: 'Messages', backHref: '/family' },
    });
  });

  it('returns null outside the app surfaces', () => {
    expect(resolveHero('/sign-in', roots)).toBeNull();
    expect(resolveHero(null, roots)).toBeNull();
  });
});

describe('resolveHero promotes the receipts-room roots', () => {
  it('promotes approvals, family, week, and trail to roots with their own hero copy', () => {
    for (const path of ['/approvals', '/family', '/plan', '/trail']) {
      const res = resolveHero(path, roots);
      expect(res?.kind).toBe('root');
      expect((res?.hero as RootHero).subtitle.length).toBeGreaterThan(0);
    }
    expect((resolveHero('/plan', roots)?.hero as RootHero).title).toBe('Week');
    expect((resolveHero('/trail', roots)?.hero as RootHero).title).toBe('Trail');
    expect((resolveHero('/approvals', roots)?.hero as RootHero).title).toBe('Approvals');
    expect((resolveHero('/family', roots)?.hero as RootHero).title).toBe('Family');
  });
});

describe('buildRootHeroes', () => {
  it('carries the live greeting into the home hero title', () => {
    const built = buildRootHeroes({ greeting: 'Good morning, Barton' });
    expect(built['/home'].title).toBe('Good morning, Barton');
  });
});
