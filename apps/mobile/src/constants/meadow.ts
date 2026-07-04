import { useColorScheme } from 'react-native';

/**
 * Concrete hex for the Meadow tokens, mirroring src/global.css. NativeWind
 * className tokens cover styling; this exists only for APIs that need a literal
 * color value and can't read a className — SF Symbols (expo-symbols tintColor).
 * Keep in sync with global.css.
 */
const MEADOW = {
  light: {
    ink: '#0c1626',
    ink2: '#434c5c',
    ink3: '#737c89',
    canvas: '#f6f6f4',
    accentFill: '#e96a44',
  },
  dark: {
    ink: '#f4f5f7',
    ink2: '#aeb5c1',
    ink3: '#7b8390',
    canvas: '#0c1420',
    accentFill: '#f4835f',
  },
} as const;

export type MeadowColor = keyof typeof MEADOW.light;

export function useMeadowColor(name: MeadowColor): string {
  const scheme = useColorScheme();
  return MEADOW[scheme === 'dark' ? 'dark' : 'light'][name];
}
