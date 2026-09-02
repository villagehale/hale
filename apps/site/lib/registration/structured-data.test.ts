import { describe, expect, it } from 'vitest';
import { SITE_URL } from '~/lib/app-url';
import { REGISTRATION_GUIDES } from './index';
import { registrationJsonLd } from './structured-data';

describe('registration JSON-LD', () => {
  it('emits Article + FAQPage for every guide, with dateModified', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const graph = registrationJsonLd(guide)['@graph'] as Array<Record<string, unknown>>;
      const types = graph.map((node) => node['@type']);
      expect(types).toEqual(expect.arrayContaining(['Article', 'FAQPage']));
      const article = graph.find((node) => node['@type'] === 'Article');
      expect(article?.dateModified).toBe(guide.updated);
      expect(article?.url).toBe(`${SITE_URL}${guide.path}`);
      const faq = graph.find((node) => node['@type'] === 'FAQPage');
      const entities = faq?.mainEntity as Array<Record<string, unknown>>;
      expect(entities).toHaveLength(guide.faqs.length);
    }
  });

  it('does not type these pages as MedicalWebPage', () => {
    for (const guide of REGISTRATION_GUIDES) {
      const raw = JSON.stringify(registrationJsonLd(guide));
      expect(raw).not.toContain('MedicalWebPage');
    }
  });
});
