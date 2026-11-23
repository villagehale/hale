import { describe, expect, it } from 'vitest';
import { metadata } from './page';

describe('demo checkout title', () => {
  it('uses the same Checkout title as the live page', () => {
    expect(metadata.title).toBe('Checkout');
  });
});
