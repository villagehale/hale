import type { DocumentView } from './api-types';

/** The document categories the vault accepts (mirrors web DOC_KINDS: Health /
 * Insurance / Other), with the sheet's chip labels. */
export const DOC_KINDS = ['health', 'insurance', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  health: 'Health',
  insurance: 'Insurance',
  other: 'Other',
};

/** The list filter axis — the three kinds plus an "all" that narrows nothing. */
export const DOC_FILTERS = ['all', 'health', 'insurance', 'other'] as const;
export type DocFilter = (typeof DOC_FILTERS)[number];

export const DOC_FILTER_LABEL: Record<DocFilter, string> = {
  all: 'All',
  health: 'Health',
  insurance: 'Insurance',
  other: 'Other',
};

/** Narrows the already-loaded, teen-redacted list by kind — 'all' passes everything
 * through unchanged. Pure client-side filter (no request), preserving list order. */
export function filterDocuments(docs: DocumentView[], filter: DocFilter): DocumentView[] {
  if (filter === 'all') return docs;
  return docs.filter((doc) => doc.kind === filter);
}

/** The non-file multipart fields for an upload — childId is appended ONLY when a
 * child is attached (a family-wide doc sends none), so the route reads it as absent
 * rather than an empty string. The file itself is appended by the caller. */
export function buildDocFormFields(args: {
  kind: DocKind;
  title: string;
  childId: string | null;
}): Record<string, string> {
  const fields: Record<string, string> = { kind: args.kind, title: args.title };
  if (args.childId !== null) fields.childId = args.childId;
  return fields;
}
