import { router } from 'expo-router';
import { View } from 'react-native';

import { AppText } from './app-text';
import { IconButton } from './icon-button';

export function ScreenHeader({ title, back = false }: { title: string; back?: boolean }) {
  return (
    <View className="flex-row items-center gap-3 pt-2">
      {back ? (
        <IconButton
          icon="chevron-left"
          accessibilityLabel="Go back"
          size={18}
          onPress={() => router.back()}
        />
      ) : null}
      <AppText variant="display">{title}</AppText>
    </View>
  );
}
