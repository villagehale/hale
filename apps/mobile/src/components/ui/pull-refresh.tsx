import { RefreshControl } from 'react-native';

import { useMeadowColor } from '@/constants/meadow';

/**
 * The list pull-to-refresh control, tinted to match the screen. Returns a real
 * RefreshControl element (ScrollView clones it, so it must be RefreshControl, not
 * a wrapper component). Call from a component body — it reads the theme color.
 */
export function useTintedRefresh(refreshing: boolean, onRefresh: () => void) {
  const tint = useMeadowColor('ink3');
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={tint} />;
}
