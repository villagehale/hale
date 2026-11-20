import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

describe('villagehale.com/founding', () => {
  it('forwards first-touch click ids onto the app join URL', () => {
    expect(source).toContain('ATTRIBUTION_KEYS');
    expect(source).toContain('searchParams');
    expect(source).toContain('/founding${suffix}');
  });
});
