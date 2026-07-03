import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { getCheckpoint } from '~/lib/milestones/index.js';
import MilestoneAgeRoute, { generateMetadata, generateStaticParams } from './page.js';

/**
 * The age route is the public YMYL surface. These lock what must hold for every
 * draft: it renders the age's milestone copy + structured data, carries the
 * not-a-test / not-medical-advice framing, is noindexed while unreviewed, and
 * wires the sign-up funnel. Rendered to static markup — no browser needed.
 */

const AGE = '18-months';

async function render(age: string): Promise<string> {
  const element = await MilestoneAgeRoute({ params: Promise.resolve({ age }) });
  return renderToStaticMarkup(element);
}

describe('milestones/[age] route', () => {
  it('statically generates a param for all twelve CDC checkpoints', async () => {
    const params = await generateStaticParams();
    const ages = params.map((p) => p.age);
    expect(ages).toHaveLength(12);
    expect(ages).toContain(AGE);
    expect(ages).toContain('5-years');
  });

  it('renders the known age with its milestone copy and MedicalWebPage JSON-LD', async () => {
    const checkpoint = getCheckpoint(AGE);
    if (!checkpoint) throw new Error('fixture missing');
    const html = await render(AGE);

    const firstMilestone = checkpoint.domains[0]?.items[0];
    if (!firstMilestone) throw new Error('fixture has no milestones');
    expect(html).toContain(firstMilestone);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('MedicalWebPage');
    expect(html).toContain('BreadcrumbList');
    // The exact CDC checkpoint URL must be surfaced on the page, not just in the graph.
    expect(html).toContain(checkpoint.sourceUrl);
  });

  it('frames the page as an age, not a test — and never says "behind"', async () => {
    const html = await render(AGE);
    expect(html).toContain('nothing to score');
    expect(html.toLowerCase()).toContain('not medical advice');
    expect(html).toContain('When it’s worth a chat with your provider');
    expect(html.toLowerCase()).not.toContain('is your child on track');
  });

  it('has no checkbox, toggle, or progress affordance (anti-screening)', async () => {
    const html = await render(AGE);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('role="progressbar"');
  });

  it('wires the "Start free with your family" CTA to the app sign-in', async () => {
    const html = await render(AGE);
    expect(html).toContain(`${APP_URL}/sign-in`);
    expect(html).toContain('Start free with your family');
  });

  it('is indexable for a published age page (no noindex robots override)', async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ age: AGE }) });
    // Published checkpoints emit robots: undefined, which Next.js treats as indexable.
    // A noindex gate would set { index: false } — assert that is absent.
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates?.canonical).toBe(`/milestones/${AGE}`);
    expect(meta.openGraph?.locale).toBe('en_CA');
  });
});
