import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { useMeadowColor } from '@/constants/meadow';
import { ApiError, api } from '@/lib/api-client';
import type { MobileDocUploadResponse } from '@/lib/api-types';
import { DOC_KINDS, DOC_KIND_LABEL, type DocKind, buildDocFormFields } from '@/lib/docs';

type ChildOption = { id: string; name: string | null };

/**
 * The add-document sheet: a kind (Health / Insurance / Other), a title, an optional
 * child (only when the family has more than one), and a picked file (image or PDF).
 * POSTs a multipart FormData to the audited /api/mobile/docs route (rule #6).
 * The file is appended RN-style as { uri, name, type }, which
 * React Native's FormData accepts; the api() client leaves the content-type unset for
 * FormData so fetch adds the multipart boundary. Errors surface in place.
 */
export function DocsAddSheet({
  childId,
  kids,
  visible,
  onClose,
  onUploaded,
}: {
  /** The child pre-selected when the family has more than one, or null for family-wide. */
  childId: string | null;
  kids: ChildOption[];
  visible: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [kind, setKind] = useState<DocKind>('health');
  const [title, setTitle] = useState('');
  const [selectedChildId, setSelectedChildId] = useState<string | null>(childId);
  const [file, setFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useMeadowColor('ink3');

  useEffect(() => {
    if (visible) {
      setKind('health');
      setTitle('');
      setSelectedChildId(childId);
      setFile(null);
      setError(null);
      setSaving(false);
    }
  }, [visible, childId]);

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/*', 'application/pdf'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    setFile(result.assets[0] ?? null);
    setError(null);
  };

  const save = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Give the document a short title.');
      return;
    }
    if (!file) {
      setError('Pick a file (an image or a PDF) to add.');
      return;
    }
    setError(null);
    setSaving(true);

    const form = new FormData();
    // React Native's FormData accepts a file as { uri, name, type }; fetch reads the
    // local file uri and streams it as the multipart part.
    form.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
    for (const [key, value] of Object.entries(
      buildDocFormFields({ kind, title: cleanTitle, childId: selectedChildId }),
    )) {
      form.append(key, value);
    }

    try {
      await api<MobileDocUploadResponse>('/api/mobile/docs', { method: 'POST', body: form });
      onUploaded();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <AppText variant="title" className="mb-4">
        Add a document
      </AppText>

      <View className="mb-5 gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Type
        </AppText>
        <View className="flex-row gap-2">
          {DOC_KINDS.map((k) => {
            const active = k === kind;
            return (
              <Pressable
                key={k}
                accessibilityRole="button"
                accessibilityLabel={DOC_KIND_LABEL[k]}
                accessibilityState={active ? { selected: true } : {}}
                onPress={() => setKind(k)}
                className={`h-11 flex-1 items-center justify-center rounded-full border ${
                  active ? 'border-ink bg-ink' : 'border-rule bg-card'
                }`}
              >
                <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                  {DOC_KIND_LABEL[k]}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="mb-5">
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="Vaccination record"
          autoCapitalize="sentences"
          maxLength={120}
          autoFocus
        />
      </View>

      {kids.length > 1 ? (
        <View className="mb-5 gap-2">
          <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
            For
          </AppText>
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="For: the whole family"
              accessibilityState={selectedChildId === null ? { selected: true } : {}}
              onPress={() => setSelectedChildId(null)}
              className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
                selectedChildId === null ? 'border-ink bg-ink' : 'border-rule bg-card'
              }`}
            >
              <AppText variant="meta" className={selectedChildId === null ? 'text-on-ink' : 'text-ink-2'}>
                Family
              </AppText>
            </Pressable>
            {kids.map((child) => {
              const active = child.id === selectedChildId;
              return (
                <Pressable
                  key={child.id}
                  accessibilityRole="button"
                  accessibilityLabel={`For: ${child.name ?? 'child'}`}
                  accessibilityState={active ? { selected: true } : {}}
                  onPress={() => setSelectedChildId(child.id)}
                  className={`min-h-11 items-center justify-center rounded-full border px-4 py-2.5 ${
                    active ? 'border-ink bg-ink' : 'border-rule bg-card'
                  }`}
                >
                  <AppText variant="meta" className={active ? 'text-on-ink' : 'text-ink-2'}>
                    {child.name ?? 'Child'}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View className="mb-5 gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          File
        </AppText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={file ? `File: ${file.name}. Tap to change.` : 'Pick a file'}
          onPress={pickFile}
          className="min-h-12 flex-row items-center gap-2.5 rounded-md border border-rule bg-card px-4 py-3 active:opacity-80"
        >
          <Icon name="doc.text.fill" size={16} color={iconColor} />
          <AppText variant="body" numberOfLines={1} className={file ? 'flex-1 text-ink' : 'flex-1 text-ink-3'}>
            {file ? file.name : 'Choose an image or PDF'}
          </AppText>
        </Pressable>
      </View>

      {error ? (
        <AppText variant="meta" className="mb-3 text-berry" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}

      <Button label={saving ? 'Adding…' : 'Add document'} onPress={save} disabled={saving} />
    </Sheet>
  );
}
