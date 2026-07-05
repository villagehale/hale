import { useColorScheme } from 'react-native';

/**
 * Concrete hex for the Meadow tokens, mirroring src/global.css. NativeWind
 * className tokens cover styling; this exists only for APIs that need a literal
 * color value and can't read a className — SF Symbols (expo-symbols tintColor).
 * Keep in sync with global.css.
 */
const MEADOW = {
  light: {
    ink: '#01204f',
    ink2: '#33486b',
    ink3: '#5b6b86',
    canvas: '#f6f1e7',
    accentFill: '#c8622d',
    onAccent: '#01204f',
  },
  dark: {
    ink: '#f6f1e7',
    ink2: '#c7d3e6',
    ink3: '#9bb0d0',
    canvas: '#0b1626',
    accentFill: '#e8915c',
    onAccent: '#01204f',
  },
} as const;

export type MeadowColor = keyof typeof MEADOW.light;

export function useMeadowColor(name: MeadowColor): string {
  const scheme = useColorScheme();
  return MEADOW[scheme === 'dark' ? 'dark' : 'light'][name];
}
