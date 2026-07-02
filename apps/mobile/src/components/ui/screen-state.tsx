import { ActivityIndicator, View } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

import { AppText } from './app-text';
import { Button } from './button';
import { Card } from './card';

export function LoadingState() {
  const tint = useMeadowColor('ink3');
  return (
    <View className="mt-16 items-center">
      <ActivityIndicator color={tint} />
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="mt-2 items-center gap-2 py-10">
      <AppText variant="title">Something went wrong</AppText>
      <AppText variant="meta" className="text-center">
        {message}
      </AppText>
      <Button label="Try again" variant="secondary" onPress={onRetry} className="mt-1" />
    </Card>
  );
}
