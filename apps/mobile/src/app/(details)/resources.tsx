import { type Href, router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { DetailHeader } from '@/components/ui/detail-header';
import { Icon, type IconName } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { type ChipTone, TintChip } from '@/components/ui/tint-chip';
import { useMeadowColor } from '@/constants/meadow';
import type { MobileFamilyResponse } from '@/lib/api-types';
import { orderByIntents } from '@/lib/intent-ordering';
import { findGuide } from '@/lib/stub-data';
import { useApi } from '@/lib/use-api';

type ResourceRow = {
  title: string;
  sub: string;
  icon: IconName;
  tone: ChipTone;
  href: Href;
  /** The onboarding intent this row speaks to — a family that stated it floats the row
   * up (deterministic reorder). Guide rows read it from GUIDES (single source); a
   * non-guide row maps directly. Omitted when no intent maps (Government Benefits). */
  intent?: string;
};

/**
 * The Resources directory (handoff), reached from More → Library. Five rows in the
 * prototype's order: the two rows that already have their own detail page (Government
 * Benefits, Finding childcare) and three that open a `/guide/[id]` editorial page. No
 * dead rows — every href points at a page that exists (the guide ids match GUIDES).
 * The family's stated intents float matching rows up (stable order otherwise).
 */
const RESOURCE_ROWS: readonly ResourceRow[] = [
  {
    title: 'Government Benefits',
    sub: 'Programs your family may qualify for',
    icon: 'credit-card',
    tone: 'yellow',
    href: '/benefits',
  },
  {
    title: 'Sleep & settling',
    sub: 'By age, from newborn to toddler',
    icon: 'moon',
    tone: 'blue',
    href: '/guide/sleep',
    intent: findGuide('sleep')?.intent,
  },
  {
    title: 'Starting solids',
    sub: 'First foods, allergens & meal ideas',
    icon: 'utensils',
    tone: 'green',
    href: '/guide/solids',
    intent: findGuide('solids')?.intent,
  },
  {
    title: 'Finding childcare',
    sub: 'Licensed centres, home care & waitlists',
    icon: 'house',
    tone: 'teal',
    href: '/childcare',
    intent: 'childcare',
  },
  {
    title: 'First aid basics',
    sub: 'What to do, when to call',
    icon: 'briefcase-medical',
    tone: 'red',
    href: '/guide/firstaid',
    intent: findGuide('firstaid')?.intent,
  },
];

export default function ResourcesScreen() {
  const chevron = useMeadowColor('ink3');
  // Reuse the Family payload (intents already live there) — the list renders in its
  // prototype order first, then floats matched rows up once the read lands. A failed
  // read simply keeps the default order (no gate), so the directory is never blank.
  const { data } = useApi<MobileFamilyResponse>('/api/mobile/family');
  const rows = orderByIntents(RESOURCE_ROWS, (row) => row.intent, data?.basics.intents ?? []);

  return (
    <Screen scroll className="gap-4">
      <DetailHeader title="Resources" />
      <View className="overflow-hidden rounded-[20px] border border-rule bg-card">
        {rows.map((row, i) => (
          <Pressable
            key={row.title}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}. ${row.sub}`}
            onPress={() => router.push(row.href)}
            className={`flex-row items-center gap-3 px-4 py-3.5 active:opacity-80 ${
              i === rows.length - 1 ? '' : 'border-b border-hairline'
            }`}
          >
            <TintChip icon={row.icon} tone={row.tone} />
            <View className="flex-1">
              <AppText
                className="text-[14px] text-ink"
                style={{ fontFamily: 'InstrumentSans_600SemiBold' }}
              >
                {row.title}
              </AppText>
              <AppText variant="meta" className="text-caption">
                {row.sub}
              </AppText>
            </View>
            <Icon name="chevron-right" size={15} color={chevron} />
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}
