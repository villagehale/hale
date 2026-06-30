import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Screen } from '@/components/ui/screen';

const ITEMS = ['Children', 'Co-parents', 'Privacy & consent', 'Notifications', 'Account'];

export default function MoreScreen() {
  return (
    <Screen scroll className="gap-5">
      <AppText variant="display" className="pt-2">
        More
      </AppText>
      <View className="overflow-hidden rounded-lg border border-rule bg-card">
        {ITEMS.map((item, i) => (
          <View
            key={item}
            className={`px-4 py-4 ${i < ITEMS.length - 1 ? 'border-rule border-b' : ''}`}
          >
            <AppText variant="body" className="text-ink">
              {item}
            </AppText>
          </View>
        ))}
      </View>
    </Screen>
  );
}
