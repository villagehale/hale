import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GUIDE_STAGE_FILTERS } from '~/lib/answers/guide-stage.js';
import { publishedAnswers } from '~/lib/answers/index.js';
import AnswersIndexPage from './page.js';

/**
 * The index filter as it ships with JavaScript off. renderToStaticMarkup does
 * not run effects, so this is the progressive-enhancement tree: every card,
 * All stages pressed, and the counts taken from the published corpus.
 */

async function render(locale: 'en' | 'fr' | 'zh'): Promise<string> {
  const element = await AnswersIndexPage({ params: Promise.resolve({ locale }) });
  return renderToStaticMarkup(element);
}

function chipButtons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*class="sp-chip"[^>]*>[\s\S]*?<\/button>/g)].map(
    (match) => match[0],
  );
}

describe('/answers stage filter without JavaScript', () => {
  it('renders every published card and derives the chip counts from them', async () => {
    const html = await render('en');
    const cards = [...html.matchAll(/<article[^>]*class="hs-card sp-card sp-guide"[^>]*>/g)];
    expect(publishedAnswers).toHaveLength(15);
    expect(cards).toHaveLength(15);
    expect(cards.every((card) => !/\shidden(?:=|\s|>)/.test(card[0]))).toBe(true);

    const counts = Object.fromEntries(
      GUIDE_STAGE_FILTERS.map((stage) => [
        stage.param,
        publishedAnswers.filter((page) => page.stage === stage.stage).length,
      ]),
    );
    expect(counts).toEqual({ newborn: 5, toddler: 5, 'school-age': 3, teenager: 2 });

    const buttons = chipButtons(html);
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toContain('aria-pressed="true"');
    expect(buttons[0]).toContain('All stages');
    expect(buttons[0]).toContain('>15<');
    for (const button of buttons.slice(1)) {
      expect(button).toContain('aria-pressed="false"');
    }
    expect(html).toContain('data-stage="newborn"');
    expect(html).toContain('data-stage="school-age"');
    expect(html).toContain('>5<');
    expect(html).toContain('>3<');
    expect(html).toContain('>2<');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Filter guides by stage"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Showing 15 of 15 guides');
    expect(html).toContain('15 questions parents search.');
    expect(html).not.toContain('No guides for this stage yet.');
  });

  it('keeps the French and Chinese index chrome in the cleared copy', async () => {
    const fr = await render('fr');
    const zh = await render('zh');
    expect(fr).toContain('15 questions que les parents cherchent.');
    expect(fr).toContain('Toutes les étapes');
    expect(fr).toContain('Nouveau-né');
    expect(fr).toContain('aria-label="Filtrer les guides par étape"');
    expect(fr).toContain('15 guides sur 15 affichés');
    expect(zh).toContain('家长常搜的 15 个问题。');
    expect(zh).toContain('所有阶段');
    expect(zh).toContain('新生儿');
    expect(zh).toContain('aria-label="按阶段筛选指南"');
    expect(zh).toContain('显示 15 篇，共 15 篇指南');
  });
});

describe('the index empty library', () => {
  it('shows the review copy when nothing is published', async () => {
    vi.resetModules();
    vi.doMock('~/lib/answers/index', async (importOriginal) => {
      const actual = await importOriginal<typeof import('~/lib/answers/index.js')>();
      return { ...actual, publishedAnswers: [] };
    });
    const { RedesignAnswers } = await import('~/components/redesign/answers.js');
    const html = renderToStaticMarkup(
      RedesignAnswers({ locale: 'en', smsNumber: '', prefill: '' }),
    );
    expect(html).toContain('Our first parenting guides are in review.');
    expect(html).not.toContain('Filter guides by stage');
    expect(html).toContain('0 questions parents search.');
    vi.doUnmock('~/lib/answers/index');
  });
});
