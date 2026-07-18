import type { ComponentType } from 'react';
import {
  ArrowUp,
  Baby,
  Bell,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  BriefcaseMedical,
  Building2,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleHelp,
  CircleStop,
  CircleX,
  Clock,
  CreditCard,
  Droplet,
  Ellipsis,
  FileText,
  Heart,
  House,
  LogOut,
  Mail,
  Map as MapIcon,
  MapPin,
  Mic,
  Moon,
  Pencil,
  Plus,
  Search,
  Settings,
  Share,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareArrowOutUpRight,
  SquarePen,
  Star,
  Syringe,
  Trash2,
  User,
  Users,
  Utensils,
  X,
} from 'lucide-react-native';
import Svg, { Circle, Path } from 'react-native-svg';

/** The subset of props the Icon component passes to every glyph — Lucide icons
 * accept these (and more); the three hand-authored glyphs below accept exactly
 * these. Keeps the ICONS map a single homogeneous component type. */
type IconGlyph = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/**
 * Hand-authored glyphs the Lucide set doesn't carry, traced from the handoff
 * prototype's own SVGs so they sit in the same 24-unit viewBox at 1.8px stroke.
 * `Houses` is the Village nav mark (a peaked-roof building cluster); `SparkleFilled`
 * and `EllipsisFilled` are the prototype's two FILLED marks (fill, not stroke) — the
 * Ask-header sparkle and the More-tab ellipsis.
 */
function Houses({ size = 24, color = 'currentColor', strokeWidth = 1.8 }: {
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d="M3 21V10l6-4 6 4v11" />
      <Path d="M15 10l3-2 3 2v11" />
      <Path d="M9 21v-5h2v5" />
    </Svg>
  );
}

function SparkleFilled({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 3l.8 2.2L22 6l-2.2.8L19 9l-.8-2.2L16 6l2.2-.8z" />
    </Svg>
  );
}

function EllipsisFilled({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Circle cx={5} cy={12} r={1.8} />
      <Circle cx={12} cy={12} r={1.8} />
      <Circle cx={19} cy={12} r={1.8} />
    </Svg>
  );
}

// Lucide outline set, 1.8px stroke per the design handoff, plus the three
// hand-authored glyphs above. `MapIcon` is imported but the Village tab maps to
// the custom `houses` mark (the handoff draws a cluster of homes, not a folded map).
const ICONS = {
  'arrow-up': ArrowUp,
  baby: Baby,
  bell: Bell,
  bookmark: Bookmark,
  'bookmark-check': BookmarkCheck,
  'book-open': BookOpen,
  'briefcase-medical': BriefcaseMedical,
  'building-2': Building2,
  calendar: Calendar,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'circle-check': CircleCheck,
  'circle-help': CircleHelp,
  'circle-stop': CircleStop,
  'circle-x': CircleX,
  clock: Clock,
  'credit-card': CreditCard,
  droplet: Droplet,
  ellipsis: Ellipsis,
  'ellipsis-filled': EllipsisFilled,
  'file-text': FileText,
  heart: Heart,
  house: House,
  houses: Houses,
  'log-out': LogOut,
  mail: Mail,
  map: MapIcon,
  'map-pin': MapPin,
  mic: Mic,
  moon: Moon,
  pencil: Pencil,
  plus: Plus,
  search: Search,
  settings: Settings,
  share: Share,
  shield: Shield,
  'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles,
  'sparkle-filled': SparkleFilled,
  'square-arrow-out-up-right': SquareArrowOutUpRight,
  'square-pen': SquarePen,
  star: Star,
  syringe: Syringe,
  'trash-2': Trash2,
  user: User,
  users: Users,
  utensils: Utensils,
  x: X,
} satisfies Record<string, IconGlyph>;

export type IconName = keyof typeof ICONS;

export type IconProps = {
  name: IconName;
  size?: number;
  color: string;
};

export function Icon({ name, size = 20, color }: IconProps) {
  const Glyph = ICONS[name];
  return <Glyph size={size} color={color} strokeWidth={1.8} />;
}
