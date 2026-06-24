import { describe, expect, it } from 'vitest';
import { _internal } from './context';

/**
 * Per-child focus reaching the agent context. The parent picks a child via the
 * chip; that child's slice must ground the agent on the right stage — and a teen's
 * slice must be redacted to stage only (rule #1: no name, no age, no companion
 * detail). A focus id naming no child of the family resolves to null (no
 * cross-family leak), falling back to the family scope.
 */

const NOW = new Date('2026-06-17T00:00:00Z');

const ROWS = [
  { id: 'tot', name: 'Mara', dateOfBirth: '2024-05-01' }, // ~25mo → toddler
  { id: 'teen', name: 'Eli', dateOfBirth: '2010-01-01' }, // 16y → teenager
];

describe('toFocusedChild', () => {
  it('surfaces a non-teen child with name, age, stage, and the companion view', () => {
    const focused = _internal.toFocusedChild('tot', ROWS, NOW);
    expect(focused).not.toBeNull();
    expect(focused?.id).toBe('tot');
    expect(focused?.stage).toBe('toddler');
    expect(focused?.name).toBe('Mara');
    expect(focused?.teenRedacted).toBe(false);
    // The deterministic companion view grounds the agent on the toddler stage.
    expect(focused?.companion?.stage).toBe('toddler');
    expect(focused?.ageMonths).toBe(25);
  });

  it('redacts a teenager to stage only — no name, age, or companion detail (rule #1)', () => {
    const focused = _internal.toFocusedChild('teen', ROWS, NOW);
    expect(focused?.stage).toBe('teenager');
    expect(focused?.teenRedacted).toBe(true);
    expect(focused?.name).toBeNull();
    expect(focused?.ageMonths).toBeNull();
    expect(focused?.companion).toBeNull();
  });

  it('resolves an unknown / cross-family focus id to null (no leak)', () => {
    expect(_internal.toFocusedChild('not-ours', ROWS, NOW)).toBeNull();
  });
});
