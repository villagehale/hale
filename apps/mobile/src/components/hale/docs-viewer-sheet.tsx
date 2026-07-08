import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { DocumentView, MobileDocDeleteResponse, MobileDocUrlResponse } from '@/lib/api-types';
import { DOC_KIND_LABEL, type DocKind } from '@/lib/docs';
import { whenPhrase } from '@/lib/format';

/**
 * The document viewer: given a selected doc, mints a short-TTL signed URL via
 * GET /api/mobile/docs/[id]/url (rule #1, per-view). An image renders inline via
 * expo-image; a PDF opens externally through the system browser — HONEST v1, no
 * faked inline PDF. A delete affordance DELETEs the doc after an in-sheet confirm
 * (rule #6 audit on the route). expo-image + expo-web-browser are imported only here.
 */
export function DocsViewerSheet({
  doc,
  visible,
  onClose,
  onDeleted,
}: {
  doc: DocumentView | null;
  visible: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const iconColor = useMeadowColor('ink3');
  const onInk = useMeadowColor('onAccent');

  useEffect(() => {
    if (!visible || !doc) return;
    let live = true;
    setUrl(null);
    setLoading(true);
    setError(null);
    setConfirmingDelete(false);
    setDeleting(false);
    api<MobileDocUrlResponse>(`/api/mobile/docs/${doc.id}/url`)
      .then((res) => {
        if (live) setUrl(res.url);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [visible, doc]);

  if (!doc) return null;
  const isImage = doc.mime.startsWith('image/');
  const kindLabel = DOC_KIND_LABEL[doc.kind as DocKind] ?? doc.kind;

  const openExternally = () => {
    if (url) void WebBrowser.openBrowserAsync(url);
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api<MobileDocDeleteResponse>(`/api/mobile/docs/${doc.id}`, { method: 'DELETE' });
      onDeleted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
      setDeleting(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View className="mb-1 flex-row items-start justify-between gap-3">
        <AppText variant="title" className="flex-1">
          {doc.title}
        </AppText>
      </View>
      <AppText variant="meta" className="mb-4 text-ink-3">
        {kindLabel} · {whenPhrase(doc.createdAt)}
      </AppText>

      {loading ? (
        <View className="items-center py-12">
          <ActivityIndicator color={iconColor} />
        </View>
      ) : error ? (
        <AppText variant="body" className="py-6 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : isImage && url ? (
        <Image
          source={{ uri: url }}
          contentFit="contain"
          className="mb-4 h-72 w-full rounded-md bg-raised"
          accessibilityLabel={doc.title}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open document"
          onPress={openExternally}
          className="mb-4 min-h-12 flex-row items-center justify-center gap-2 rounded-full border border-ink bg-ink px-4 py-3.5 active:opacity-80"
        >
          <Icon name="square.and.arrow.up" size={15} color={onInk} />
          <AppText variant="meta" className="text-on-ink">
            Open document
          </AppText>
        </Pressable>
      )}

      {confirmingDelete ? (
        <View className="mt-1 gap-3 rounded-md border border-rule bg-raised p-4">
          <AppText variant="body" className="text-ink">
            Remove this document? This can't be undone.
          </AppText>
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Yes, remove this document"
              accessibilityState={{ disabled: deleting }}
              disabled={deleting}
              onPress={remove}
              className={`min-h-11 flex-1 items-center justify-center rounded-full border border-berry ${
                deleting ? 'opacity-50' : 'active:opacity-80'
              }`}
            >
              <AppText variant="meta" className="text-berry">
                {deleting ? 'Removing…' : 'Remove'}
              </AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Keep this document"
              onPress={() => setConfirmingDelete(false)}
              className="min-h-11 flex-1 items-center justify-center rounded-full border border-rule bg-card active:opacity-80"
            >
              <AppText variant="meta" className="text-ink-2">
                Keep
              </AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove this document"
          onPress={() => setConfirmingDelete(true)}
          className="mt-1 min-h-11 flex-row items-center justify-center gap-2 active:opacity-70"
        >
          <Icon name="trash" size={15} color={iconColor} />
          <AppText variant="meta" className="text-ink-3">
            Remove this document
          </AppText>
        </Pressable>
      )}
    </Sheet>
  );
}
