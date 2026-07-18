import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { ErrorState, LoadingState } from '@/components/ui/screen-state';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type {
  DocumentView,
  MobileDocDeleteResponse,
  MobileDocsResponse,
  MobileDocUrlResponse,
} from '@/lib/api-types';
import { DOC_KIND_LABEL, type DocKind } from '@/lib/docs';
import { whenPhrase } from '@/lib/format';
import { useApi } from '@/lib/use-api';

/**
 * The document viewer body (moved from DocsViewerSheet): mints a short-TTL signed URL
 * via GET /api/mobile/docs/:id/url (rule #1, per-view). An image renders inline via
 * expo-image; a PDF opens externally through the system browser — HONEST v1, no faked
 * inline PDF. A delete affordance DELETEs the doc after an in-page confirm (rule #6
 * audit on the route), then pops back to the vault.
 */
function DocViewerBody({ doc }: { doc: DocumentView }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const iconColor = useMeadowColor('ink3');
  const onInk = useMeadowColor('onAccent');

  useEffect(() => {
    let live = true;
    setUrl(null);
    setLoading(true);
    setError(null);
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
  }, [doc.id]);

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
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
      setDeleting(false);
    }
  };

  return (
    <>
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
          <Icon name="share" size={15} color={onInk} />
          <AppText variant="meta" className="text-on-ink">
            Open document
          </AppText>
        </Pressable>
      )}

      {confirmingDelete ? (
        <View className="mt-1 gap-3 rounded-md border border-rule bg-raised p-4">
          <AppText variant="body" className="text-ink">
            Remove this document? This can&rsquo;t be undone.
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
          <Icon name="trash-2" size={15} color={iconColor} />
          <AppText variant="meta" className="text-ink-3">
            Remove this document
          </AppText>
        </Pressable>
      )}
    </>
  );
}

/**
 * The pushed Document-viewer route (sheet→stack conversion). Takes the doc id and
 * re-reads the vault list to resolve it the SAME way the sheet derived it from props;
 * the signed URL is still minted per-view inside the body (rule #1). A missing /
 * redacted id (the list already drops a teen-redacted doc, rule #1) renders an honest
 * empty state, never a crash.
 */
export default function DocsDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, data, error, reload } = useApi<MobileDocsResponse>('/api/mobile/docs');
  const doc = data?.documents.find((d) => d.id === id) ?? null;

  return (
    <Screen scroll className="gap-5">
      <DetailHeader title="Document" />
      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState message={error ?? ''} onRetry={reload} /> : null}
      {status === 'ready' && doc ? <DocViewerBody doc={doc} /> : null}
      {status === 'ready' && !doc ? (
        <Card className="mt-2 items-center gap-2 py-10">
          <AppText variant="title">Not available</AppText>
          <AppText variant="meta" className="text-center">
            This document is no longer available. Head back to your documents.
          </AppText>
        </Card>
      ) : null}
    </Screen>
  );
}
