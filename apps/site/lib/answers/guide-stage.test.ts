import { describe, expect, it } from 'vitest';
import {
  filterStageFromSearch,
  filterStatusLine,
  headingSlug,
  hrefWithStage,
  nextFilterStage,
  stageStatusSeparator,
} from './guide-stage.js';
import { publishedAnswers } from './index.js';

describe('guide stage filter', () => {
  it('reads a known ?stage= and ignores anything else', () => {
    expect(filterStageFromSearch('?stage=school-age')).toBe('school-age');
    expect(filterStageFromSearch('stage=newborn')).toBe('newborn');
    expect(filterStageFromSearch('?stage=toddler&utm=1')).toBe('toddler');
    expect(filterStageFromSearch('?stage=child')).toBeNull();
    expect(filterStageFromSearch('?stage=preschool')).toBeNull();
    expect(filterStageFromSearch('?stage=')).toBeNull();
    expect(filterStageFromSearch('')).toBeNull();
    expect(filterStageFromSearch('?utm=1')).toBeNull();
  });

  it('sets or clears stage without dropping the other params or the hash', () => {
    expect(hrefWithStage('/fr/answers?utm=1#list', 'teenager')).toBe(
      '/fr/answers?utm=1&stage=teenager#list',
    );
    expect(hrefWithStage('/answers?stage=newborn&utm=1#list', null)).toBe('/answers?utm=1#list');
    expect(hrefWithStage('/answers?stage=toddler', 'toddler')).toBe('/answers?stage=toddler');
  });

  it('leaves the filter alone when the selected chip is pressed again', () => {
    expect(nextFilterStage('newborn', 'newborn')).toBe('newborn');
    expect(nextFilterStage(null, null)).toBeNull();
    expect(nextFilterStage('newborn', null)).toBeNull();
    expect(nextFilterStage(null, 'toddler')).toBe('toddler');
    expect(nextFilterStage('newborn', 'toddler')).toBe('toddler');
  });

  it('fills the status line and appends the stage only when one is selected', () => {
    const template = 'Showing {n} of {total} guides';
    expect(filterStatusLine(template, 15, 15, null)).toBe('Showing 15 of 15 guides');
    expect(filterStatusLine(template, 5, 15, 'Newborn')).toBe('Showing 5 of 15 guides: Newborn');
    expect(filterStatusLine(template, 0, 15, 'Toddler')).toBe('Showing 0 of 15 guides: Toddler');
    expect(stageStatusSeparator('en')).toBe(': ');
    expect(stageStatusSeparator('fr')).toBe(' : ');
    expect(stageStatusSeparator('zh')).toBe('：');
    expect(filterStatusLine(template, 5, 15, 'Nouveau-né', stageStatusSeparator('fr'))).toBe(
      'Showing 5 of 15 guides : Nouveau-né',
    );
    expect(filterStatusLine(template, 5, 15, '新生儿', stageStatusSeparator('zh'))).toBe(
      'Showing 5 of 15 guides：新生儿',
    );
  });
});

describe('guide heading slugs', () => {
  it('slugifies a heading and stays unique on every published guide', () => {
    expect(headingSlug('The readiness signs')).toBe('the-readiness-signs');
    expect(headingSlug('Solids add to milk, they do not replace it')).toBe(
      'solids-add-to-milk-they-do-not-replace-it',
    );
    expect(headingSlug('What "how" looks like')).toBe('what-how-looks-like');

    const reserved = new Set(['short-answer', 'parents-also-ask', 'sources', 'key-takeaways']);
    for (const page of publishedAnswers) {
      const ids = page.sections.map((section) => headingSlug(section.heading));
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      for (const id of ids) {
        expect(id.length, page.slug).toBeGreaterThan(0);
        expect(reserved.has(id), `${page.slug} #${id}`).toBe(false);
      }
    }
  });
});
