import { describe, expect, it } from 'vitest';
import { formatOffsetIso, interpretCheckBack, resolveCheckBackAt } from './workstream-time';

/** 11:00 in America/Toronto (EDT, UTC−4). */
const NOW = new Date('2026-08-12T15:00:00.000Z');
const ZONE = 'America/Toronto';

describe('workstream clock', () => {
  it('prints now with the family offset', () => {
    expect(formatOffsetIso(NOW, ZONE)).toBe('2026-08-12T11:00:00-04:00');
  });

  it('reads a naive clock time as wall time in the family timezone', () => {
    expect(interpretCheckBack('2026-08-13T15:00:00', ZONE)?.toISOString()).toBe(
      '2026-08-13T19:00:00.000Z',
    );
    expect(interpretCheckBack('2026-08-20', ZONE)?.toISOString()).toBe('2026-08-20T13:00:00.000Z');
    expect(interpretCheckBack('2026-08-13T15:00:00.000Z', ZONE)?.toISOString()).toBe(
      '2026-08-13T15:00:00.000Z',
    );
  });

  it('stores a past or unreadable check-back as null', () => {
    expect(resolveCheckBackAt('2025-10-09T15:00:00.000Z', NOW, ZONE)).toBeNull();
    expect(resolveCheckBackAt('2026-08-12T10:00:00', NOW, ZONE)).toBeNull();
    expect(resolveCheckBackAt('Thursday', NOW, ZONE)).toBeNull();
    expect(resolveCheckBackAt(undefined, NOW, ZONE)).toBeUndefined();
    expect(resolveCheckBackAt('2026-08-13T15:00:00', NOW, ZONE)?.toISOString()).toBe(
      '2026-08-13T19:00:00.000Z',
    );
  });
});
