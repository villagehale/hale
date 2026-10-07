import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Stroke({
  className,
  viewBox,
  strokeWidth,
  children,
}: {
  className?: string;
  viewBox: string;
  strokeWidth: number;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function MailIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <rect x="2.75" y="4.5" width="14.5" height="11" rx="2" />
      <path d="m3.5 5.5 6.5 5 6.5-5" />
    </Stroke>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <rect x="3" y="4.5" width="14" height="12.5" rx="2.5" />
      <path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4" />
    </Stroke>
  );
}

export function GearIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" />
    </Stroke>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="m7.6 7.6 4.8 4.8M12.4 7.6l-4.8 4.8" />
    </Stroke>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
      <path d="m7 10.2 2.2 2.2L13.4 8" />
    </Stroke>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M10 6.5V10l2.5 1.5" />
    </Stroke>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 16 16" strokeWidth={1.6}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4M8 4.9v.1" />
    </Stroke>
  );
}

export function LinkIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.9-.9" />
    </Stroke>
  );
}

export function PeopleIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 20 20" strokeWidth={1.6}>
      <circle cx="7.5" cy="7" r="2.8" />
      <path d="M2.5 16.2c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2" />
      <circle cx="14" cy="7.6" r="2.2" />
      <path d="M13.6 12.1c2 .1 3.4 1.5 3.9 3.6" />
    </Stroke>
  );
}

export function EyeIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 16 16" strokeWidth={1.5}>
      <path d="M1.8 8s2.3-4.5 6.2-4.5S14.2 8 14.2 8s-2.3 4.5-6.2 4.5S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </Stroke>
  );
}

export function BanIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 16 16" strokeWidth={1.5}>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.8 12.2l8.4-8.4" />
    </Stroke>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <Stroke className={className} viewBox="0 0 16 16" strokeWidth={1.5}>
      <path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" />
    </Stroke>
  );
}

/** Official four-colour G. The button spec is the dark pill; the mark stays the standard colour G. */
export function GoogleG({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}
