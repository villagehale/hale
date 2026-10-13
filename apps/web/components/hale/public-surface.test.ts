import { describe, expect, it } from 'vitest';
import { JOIN_HREF } from './public-surface';

describe('public-surface conversion hook', () => {
  it('JOIN_HREF points at the in-app sign-up / join entry', () => {
    expect(JOIN_HREF).toBe('/sign-in');
  });
});
