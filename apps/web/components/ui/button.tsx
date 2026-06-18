import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Optional leading Lucide icon, sized to the label. */
  icon?: LucideIcon;
}

/**
 * The app button. Variants map to the token-driven .btn-* classes (Prussian
 * primary, outlined secondary, underlined-text ghost) which already carry
 * cursor, hover, active, focus-visible, and disabled styling in globals.css.
 */
export function Button({
  variant = 'primary',
  icon: LeadingIcon,
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {LeadingIcon ? <LeadingIcon size={18} strokeWidth={2} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
