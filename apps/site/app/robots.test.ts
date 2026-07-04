import { describe, expect, it } from 'vitest';
import robots from './robots.js';

/**
 * The answer corpus exists to be cited by answer engines, so robots must welcome
 * the AI crawlers — never disallow them from the public answer pages. Per-page
 * noindex is what holds drafts back; robots stays open. These assertions lock
 * that: the AI bots are named with an allow, and nothing carries a disallow.
 */

const AI_CRAWLERS = [
  'GPTBot',
  'PerplexityBot',
  'Google-Extended',
  'ClaudeBot',
  'anthropic-ai',
];

describe('robots', () => {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules : [result.rules];

  it('explicitly welcomes each AI crawler with an allow', () => {
    for (const bot of AI_CRAWLERS) {
      const rule = rules.find((r) => r.userAgent === bot);
      expect(rule, `expected an explicit rule for ${bot}`).toBeDefined();
      expect(rule?.allow).toBe('/');
      expect(rule?.disallow).toBeUndefined();
    }
  });

  it('never disallows any crawler (no path is blocked from answer pages)', () => {
    for (const rule of rules) {
      expect(rule.disallow).toBeUndefined();
    }
  });

  it('keeps the wildcard allow and points at the sitemap', () => {
    expect(rules.some((r) => r.userAgent === '*' && r.allow === '/')).toBe(true);
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
