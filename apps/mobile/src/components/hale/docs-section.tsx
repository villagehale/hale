import { memo, useCallback, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { DocsAddSheet } from '@/components/hale/docs-add-sheet';
import { DocsViewerSheet } from '@/components/hale/docs-viewer-sheet';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import type { IconName } from '@/components/ui/icon';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import type { DocumentView, MobileDocsResponse } from '@/lib/api-types';
import {
  DOC_FILTERS,
  DOC_FILTER_LABEL,
  DOC_KIND_LABEL,
  type DocFilter,
  type DocKind,
  filterDocuments,
} from '@/lib/docs';
import { whenPhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

type ChildOption = { id: string; name: string | null };

/** The SF Symbol per doc kind for the row glyph (web-mapped in icon.web.tsx). */
const KIND_ICON: Record<DocKind, IconName> = {
  health: 'briefcase-medical',
  insurance: 'shield',
  other: 'file-text',
};

/** The list-filter chip row — the SectionRow horizontal-pill idiom (companion.tsx):
 * a horizontal scroll of pills, the active one filled Prussian, the rest outlined. */
function FilterRow({
  value,
  onSelect,
}: {
  value: DocFilter;
  onSelect: (f: DocFilter) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pr-5"
    >
      {DOC_FILTERS.map((filter) => {
        const active = filter === value;
        return (
          <Pressable
            key={filter}
            accessibilityRole="button"
            accessibilityLabel={`Filter: ${DOC_FILTER_LABEL[filter]}`}
            accessibilityState={active ? { selected: true } : {}}
            onPress={() => onSelect(filter)}
            className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
              active ? 'border-ink bg-ink' : 'border-rule bg-card'
            }`}
          >
            <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
              {DOC_FILTER_LABEL[filter]}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const DocRow = memo(function DocRow({
  doc,
  first,
  iconColor,
  onOpen,
}: {
  doc: DocumentView;
  first: boolean;
  iconColor: string;
  onOpen: (doc: DocumentView) => void;
}) {
  const kindIcon = KIND_ICON[doc.kind as DocKind] ?? 'file-text';
  const kindLabel = DOC_KIND_LABEL[doc.kind as DocKind] ?? doc.kind;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open document: ${doc.title}`}
      onPress={() => onOpen(doc)}
      className={`flex-row items-center gap-3 active:opacity-80 ${
        first ? '' : 'border-t border-rule pt-3'
      }`}
    >
      <Icon name={kindIcon} size={18} color={iconColor} />
      <View className="flex-1 gap-0.5">
        <AppText variant="body" numberOfLines={1} className="text-ink">
          {doc.title}
        </AppText>
        <AppText variant="meta" className="text-ink-3">
          {kindLabel} · {whenPhrase(doc.createdAt)}
        </AppText>
      </View>
      <Icon name="chevron-right" size={13} color={iconColor} />
    </Pressable>
  );
});

/**
 * The Docs vault: a filterable list of the family's documents (teen-redacted by the
 * route, rule #1). Filter chips narrow the already-loaded list client-side via
 * filterDocuments (no new request). A row opens the viewer (a signed URL, minted per
 * view); the Add button opens the upload sheet. childId prefills the add sheet's
 * child; kids drives the sheet's child selector (shown only when more than one).
 */
export function DocsSection({
  childId,
  kids,
}: {
  childId: string;
  kids: ChildOption[];
}) {
  const { status, data, error, reload } = useApi<MobileDocsResponse>('/api/mobile/docs');
  const [filter, setFilter] = useState<DocFilter>('all');
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<DocumentView | null>(null);
  const onAccent = useMeadowColor('onAccent');
  const rowIcon = useMeadowColor('ink3');
  const openDoc = useCallback((doc: DocumentView) => setViewing(doc), []);

  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <ErrorState message={error ?? ''} onRetry={reload} />;
  if (!data) return null;

  const shown = filterDocuments(data.documents, filter);

  return (
    <>
      <FilterRow value={filter} onSelect={setFilter} />

      {data.documents.length === 0 ? (
        <Card className="items-center gap-2 py-10">
          <AppText variant="title">No documents yet</AppText>
          <AppText variant="meta" className="text-center">
            Keep a health record, an insurance card, or a letter here — add one below and it stays
            private to your family.
          </AppText>
        </Card>
      ) : shown.length === 0 ? (
        <Card className="items-center gap-2 py-10">
          <AppText variant="body" className="text-center text-ink-3">
            Nothing filed under {DOC_FILTER_LABEL[filter]} yet.
          </AppText>
        </Card>
      ) : (
        <Card className="gap-3">
          {shown.map((doc, i) => (
            <DocRow key={doc.id} doc={doc} first={i === 0} iconColor={rowIcon} onOpen={openDoc} />
          ))}
        </Card>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add a document"
        onPress={() => setAdding(true)}
        className="min-h-12 flex-row items-center justify-center gap-2 rounded-full border border-ink bg-ink px-4 active:opacity-80"
      >
        <Icon name="plus" size={15} color={onAccent} />
        <AppText variant="meta" className="text-on-ink">
          Add a document
        </AppText>
      </Pressable>

      <DocsAddSheet
        childId={childId}
        kids={kids}
        visible={adding}
        onClose={() => setAdding(false)}
        onUploaded={reload}
      />
      <DocsViewerSheet
        doc={viewing}
        visible={viewing !== null}
        onClose={() => setViewing(null)}
        onDeleted={reload}
      />
    </>
  );
}
