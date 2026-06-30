import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { PLACEHOLDER } from '@/constants/placeholder-data';

export default function CompanionScreen() {
  return (
    <Screen scroll className="gap-5">
      <AppText variant="display" className="pt-2">
        Companion
      </AppText>
      <View className="gap-3">
        {PLACEHOLDER.children.map((child) => (
          <Card key={child.name} className="gap-1">
            <View className="flex-row items-baseline justify-between">
              <AppText variant="title">{child.name}</AppText>
              <AppText variant="mono" className="text-ink-3">
                {child.ageLabel}
              </AppText>
            </View>
            <AppText variant="body" className="mt-1">
              {child.next}
            </AppText>
          </Card>
        ))}
      </View>
    </Screen>
  );
}
