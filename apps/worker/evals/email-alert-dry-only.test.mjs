import { describe, expect, it } from 'vitest';
import { dryCases } from './run-email-alert-eval.mjs';

describe('email-alert --dry case selection', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('prices every case when --only is absent', () => {
    expect(dryCases(all, null).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
  it('prices only the --only ids when given', () => {
    expect(dryCases(all, new Set(['b'])).map((f) => f.id)).toEqual(['b']);
  });
});
