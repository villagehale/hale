import { useColorScheme } from 'react-native';

/**
 * Concrete hex for the handoff tokens, mirroring src/global.css. NativeWind
 * className tokens cover styling; this exists only for APIs that need a literal
 * color value and can't read a className — Lucide icons (the Icon color prop).
 * `brand` mirrors the primary navy so a literal consumer (e.g. the tab-bar active
 * tint) can adopt it; `card` mirrors the card surface so a literal consumer (e.g. the
 * growth chart's hollow latest-point) reads on the same surface in both schemes; the
 * chip*Icon entries mirror the six tint-chip icon colors so an icon rendered inside a
 * tint chip can be tinted to match. Keep in sync with global.css (drift-gated by
 * scripts/check-token-drift.mjs).
 */
const MEADOW = {
  light: {
    ink: '#17294a',
    ink2: '#3d4c68',
    ink3: '#5c6b87',
    brand: '#1b2160',
    canvas: '#fdfcfa',
    card: '#ffffff',
    accentFill: '#f28c45',
    onAccent: '#ffffff',
    chipBlueIcon: '#3b5bdb',
    chipGreenIcon: '#1f8a4c',
    chipYellowIcon: '#b26b1f',
    chipRedIcon: '#c2543f',
    chipTealIcon: '#0f766e',
    chipGrayIcon: '#5c6b87',
  },
  dark: {
    ink: '#f6f1e7',
    ink2: '#c7d3e6',
    ink3: '#9bb0d0',
    brand: '#9aa6e6',
    canvas: '#14120e',
    card: '#1e1b15',
    accentFill: '#f97316',
    onAccent: '#17294a',
    chipBlueIcon: '#a3b6f0',
    chipGreenIcon: '#78c795',
    chipYellowIcon: '#dba64f',
    chipRedIcon: '#e79f8e',
    chipTealIcon: '#57bab1',
    chipGrayIcon: '#a6aebd',
  },
} as const;

export type MeadowColor = keyof typeof MEADOW.light;

export function useMeadowColor(name: MeadowColor): string {
  const scheme = useColorScheme();
  return MEADOW[scheme === 'dark' ? 'dark' : 'light'][name];
}
