import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AboutPage from './[locale]/about/page.js';
import ActivitiesPage from './[locale]/activities/page.js';
import AnswersPage from './[locale]/answers/page.js';
import ContactPage from './[locale]/contact/page.js';
import FaqPage from './[locale]/faq/page.js';
import PricingPage from './[locale]/pricing/page.js';

const params = Promise.resolve({ locale: 'en' as const });
const pages = [AboutPage, PricingPage, FaqPage, ContactPage, AnswersPage, ActivitiesPage];
describe('supplied October subpage language', () => {
  it.each(pages)('keeps readable content and shared navigation on %s', async (page) => {
    const html = renderToStaticMarkup(await page({ params }));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('sp-h1');
    expect(html).toContain('design-marketing');
    expect(html.match(/<header\b/g)).toHaveLength(1);
    expect(html.match(/<footer\b/g)).toHaveLength(1);
    expect(html).toMatch(/mailto:|href="\/text"/);
    expect(html).not.toMatch(/pull-word|\/onboarding|opacity:0/);
  });
  it('keeps real founder links and parent control in About', async () => {
    const html = renderToStaticMarkup(await AboutPage({ params }));
    expect(html).toContain('Barton Dong');
    expect(html).toContain('Eugene Song');
    expect(html).toContain('https://linkedin.com/in/anzhe-dong');
    expect(html).toContain('https://www.linkedin.com/in/yuhang-eugene-song-53b692172');
    expect(html).toContain('Hale finds and reminds. You register');
    expect(html).not.toContain('Hale does not book');
  });
});
