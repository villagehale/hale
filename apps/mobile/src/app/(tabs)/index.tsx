import { router } from 'expo-router';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Pill } from '@/components/ui/pill';
import { Screen } from '@/components/ui/screen';
import { useMeadowColor } from '@/constants/meadow';
import { PLACEHOLDER } from '@/constants/placeholder-data';
import { timeGreeting } from '@/lib/greeting';

export default function HomeScreen() {
  const { rightNow, village, children } = PLACEHOLDER;
  const askIconColor = useMeadowColor('ink3');

  return (
    <Screen scroll className="gap-5">
      <View className="flex-row items-center justify-between pt-2">
        <AppText variant="display">{timeGreeting()}</AppText>
        <AppText variant="title" className="text-sea">
          Hale
        </AppText>
      </View>

      <Card raised className="gap-1">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Right now
        </AppText>
        <View className="mt-1 flex-row items-baseline gap-2">
          <AppText variant="title">{rightNow.label}</AppText>
          <AppText variant="mono" className="text-accent">
            {rightNow.time}
          </AppText>
        </View>
        <AppText variant="meta" className="mt-1">
          {rightNow.detail}
        </AppText>
      </Card>

      <View className="flex-row items-center gap-2">
        <Pill label="Feed" icon="drop.fill" className="flex-1" />
        <Pill label="Nap" icon="moon.fill" className="flex-1" />
        <Pill label="Milestone" icon="star.fill" className="flex-1" />
      </View>

      <Card onPress={() => router.push('/ask')} className="flex-row items-center justify-between">
        <AppText variant="body" className="text-ink-3">
          Ask Hale anything
        </AppText>
        <Icon name="mic" size={20} color={askIconColor} />
      </Card>

      <View className="gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          From the village
        </AppText>
        <Card onPress={() => router.push('/village')} className="gap-1">
          <AppText variant="title">{village.title}</AppText>
          <AppText variant="mono" className="text-ink-3">
            {village.meta}
          </AppText>
          <AppText variant="body" className="mt-1">
            {village.blurb}
          </AppText>
        </Card>
      </View>

      <View className="gap-2">
        <AppText variant="meta" className="uppercase tracking-eyebrow text-ink-3">
          Companion
        </AppText>
        <View className="flex-row gap-3">
          {children.map((child) => (
            <Card
              key={child.name}
              onPress={() => router.push('/companion')}
              className="flex-1 gap-1"
            >
              <View className="flex-row items-baseline justify-between">
                <AppText variant="title">{child.name}</AppText>
                <AppText variant="mono" className="text-ink-3">
                  {child.ageLabel}
                </AppText>
              </View>
              <AppText variant="meta" className="mt-1">
                {child.next}
              </AppText>
            </Card>
          ))}
        </View>
      </View>
    </Screen>
  );
}
