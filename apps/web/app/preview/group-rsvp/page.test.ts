import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('preview group RSVP conversation', () => {
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
  const layout = readFileSync(fileURLToPath(new URL('../layout.tsx', import.meta.url)), 'utf8');

  it('is Preview-only and names several fake people', () => {
    expect(layout).toContain('portalDemoEnabled()');
    expect(layout).toContain('notFound()');
    expect(page).toContain('Priya');
    expect(page).toContain('Jordan');
    expect(page).toContain('Sam');
    expect(page).toContain('Before');
    expect(page).toContain('After');
    expect(page).not.toContain('Reply YES');
  });
});
