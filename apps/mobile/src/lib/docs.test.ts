import { describe, expect, it } from 'vitest';

import type { DocumentView } from './api-types';
import { buildDocFormFields, filterDocuments } from './docs';

/**
 * filterDocuments narrows the loaded vault list by kind; buildDocFormFields shapes the
 * non-file multipart fields, omitting childId for a family-wide upload. Expected values
 * are derived from the spec (the three kinds + "all"; childId present only when set),
 * not copied from output.
 */

function doc(id: string, kind: string): DocumentView {
  return {
    id,
    childId: null,
    kind,
    title: `Doc ${id}`,
    mime: 'application/pdf',
    sizeBytes: 1024,
    createdAt: '2026-07-06T08:00:00Z',
  };
}

describe('filterDocuments', () => {
  const docs: DocumentView[] = [
    doc('h1', 'health'),
    doc('i1', 'insurance'),
    doc('o1', 'other'),
    doc('h2', 'health'),
  ];

  it("'all' returns every document in the original order", () => {
    expect(filterDocuments(docs, 'all').map((d) => d.id)).toEqual(['h1', 'i1', 'o1', 'h2']);
  });

  it('narrows to a single kind, keeping order', () => {
    expect(filterDocuments(docs, 'health').map((d) => d.id)).toEqual(['h1', 'h2']);
    expect(filterDocuments(docs, 'insurance').map((d) => d.id)).toEqual(['i1']);
    expect(filterDocuments(docs, 'other').map((d) => d.id)).toEqual(['o1']);
  });

  it('returns an empty list when no document matches the kind', () => {
    expect(filterDocuments([doc('h1', 'health')], 'insurance')).toEqual([]);
  });
});

describe('buildDocFormFields', () => {
  it('omits childId for a family-wide upload (childId null)', () => {
    const fields = buildDocFormFields({ kind: 'insurance', title: 'Policy', childId: null });
    expect(fields).toEqual({ kind: 'insurance', title: 'Policy' });
    expect('childId' in fields).toBe(false);
  });

  it('includes childId when a child is attached', () => {
    const fields = buildDocFormFields({ kind: 'health', title: 'Vax record', childId: 'child-42' });
    expect(fields).toEqual({ kind: 'health', title: 'Vax record', childId: 'child-42' });
  });
});
