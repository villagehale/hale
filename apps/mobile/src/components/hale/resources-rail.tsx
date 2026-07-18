import { Linking, Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Tag } from '@/components/ui/tag';
import { useMeadowColor } from '@/constants/meadow';
import type { CuratedResourceView } from '@/lib/api-types';

/**
 * The Village "Resources" rail on mobile — a calm, directory-style list of
 * hand-verified public local programs (mirrors the web ResourcesRail). Distinct
 * from the AI-discovered RecCards: these are curated reference data, so each row is
 * quiet and outward-linking (opens the URL in the browser), never actionable. Shows
 * the name, a category chip, the coarse service area, and the description.
 *
 * Renders NOTHING when the list is empty or absent — a directory with no entries is
 * simply omitted, never a hollow shell.
 */
export function ResourcesRail({ resources }: { resources: CuratedResourceView[] | undefined }) {
  if (!resources || resources.length === 0) return null;
  return (
    <View className="gap-3">
      <View className="gap-0.5">
        <AppText variant="title">Resources near you</AppText>
        <AppText variant="meta" className="text-ink-3">
          Verified public programs &amp; supports for families.
        </AppText>
      </View>
      {resources.map((resource) => (
        <ResourceCard key={resource.id} resource={resource} />
      ))}
    </View>
  );
}

function ResourceCard({ resource }: { resource: CuratedResourceView }) {
  const iconColor = useMeadowColor('ink3');
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${resource.name}, opens in your browser`}
      onPress={() => {
        Linking.openURL(resource.url).catch(() => {
          // A failed open is a no-op — the row is a directory link, not an action.
        });
      }}
      className="active:opacity-80"
    >
      <Card className="gap-2">
        <View className="flex-row items-start justify-between gap-3">
          <View className="flex-1 gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              <Tag label={resource.category} />
              <AppText variant="meta" className="text-ink-3">
                {resource.area}
              </AppText>
            </View>
            <AppText variant="title" className="text-[17px]">
              {resource.name}
            </AppText>
          </View>
          <Icon name="square-arrow-out-up-right" size={18} color={iconColor} />
        </View>
        <AppText variant="body" className="text-ink-2">
          {resource.description}
        </AppText>
      </Card>
    </Pressable>
  );
}
