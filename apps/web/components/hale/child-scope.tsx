'use client';

import { Check } from 'lucide-react';
import { type KeyboardEvent, useId, useRef } from 'react';
import { type ChildScopeVariant, type ScopeChild, optionValues } from './child-scope-core';

// Pure derivations + types live in the server-safe ./child-scope-core so server
// components can call scopeChildren(). Types are re-exported here so existing
// `import { ChildScope, type ScopeChild } from './child-scope'` sites keep working.
export type { ChildScopeVariant, ScopeChild, StagedChild } from './child-scope-core';

/**
 * The shared per-child scope selector — one control, three shapes. "whole family"
 * is always the first, first-class option (value `null`); each child follows.
 * A teen's given name is withheld from the parent-facing label (rule #1): pass
 * `label: null` and the chip reads "your teen".
 *
 * One `variant` prop picks the interaction + the correct ARIA:
 *  - `filter`  — scope chips (the Ask precedent): a fieldset of aria-pressed
 *    toggles. Used to narrow a view to a child.
 *  - `tabs`    — a WAI-ARIA tablist with roving tabindex + arrow-key nav. Used to
 *    switch the active child on a per-child surface.
 *  - `select`  — a WAI-ARIA radiogroup (single choice) with arrow-key nav and a
 *    checkmark on the chosen option. Used to assign a plan to a child or the
 *    whole family.
 *
 * Controlled: `value` is the selected child id (or null for whole family);
 * `onChange` fires with the new value. Meadow-styled with the shared .pill /
 * .pill-action / .pill-apricot tokens — the active option is read by its LABEL
 * and, in `select`, a SHAPE (the checkmark), never by colour alone.
 */

interface ChildScopeProps {
  kids: ScopeChild[];
  value: string | null;
  onChange: (value: string | null) => void;
  variant: ChildScopeVariant;
  /** Accessible name for the group (fieldset legend / aria-label). */
  legend: string;
}

const WHOLE_FAMILY_LABEL = 'whole family';

/** The rendered options in order: whole-family (null) first, then each child. */
function scopeOptions(children: ScopeChild[]): Array<ScopeChild | null> {
  return [null, ...children];
}

function labelFor(child: ScopeChild): string {
  return child.label ?? 'your teen';
}

/** whole-family (null option) or the child's label — a teen's name is withheld. */
function ScopeOptionLabel({ option }: { option: ScopeChild | null }) {
  if (option === null) {
    return <>{WHOLE_FAMILY_LABEL}</>;
  }
  return <span data-hale-pii>{labelFor(option)}</span>;
}

export function ChildScope({ kids, value, onChange, variant, legend }: ChildScopeProps) {
  if (variant === 'tabs') {
    return <ScopeTabs kids={kids} value={value} onChange={onChange} legend={legend} />;
  }
  if (variant === 'select') {
    return <ScopeSelect kids={kids} value={value} onChange={onChange} legend={legend} />;
  }
  return <ScopeFilter kids={kids} value={value} onChange={onChange} legend={legend} />;
}

type VariantProps = Omit<ChildScopeProps, 'variant'>;

/** The scope-chip filter — a fieldset of aria-pressed toggles (the Ask precedent). */
function ScopeFilter({ kids, value, onChange, legend }: VariantProps) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0 m-0" aria-label={legend}>
      <ScopeChipButton active={value === null} onClick={() => onChange(null)}>
        {WHOLE_FAMILY_LABEL}
      </ScopeChipButton>
      {kids.map((child) => (
        <ScopeChipButton
          key={child.id}
          active={value === child.id}
          onClick={() => onChange(child.id)}
        >
          <span data-hale-pii>{labelFor(child)}</span>
        </ScopeChipButton>
      ))}
    </fieldset>
  );
}

function ScopeChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`pill pill-action cursor-pointer ${active ? 'pill-apricot' : ''}`}
    >
      {children}
    </button>
  );
}

/**
 * The tablist — roving tabindex (only the active tab is in the tab order), Left/
 * Right (and Home/End) move selection, wrapping at the ends per WAI-ARIA APG.
 */
function ScopeTabs({ kids, value, onChange, legend }: VariantProps) {
  const values = optionValues(kids);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function move(nextIndex: number) {
    const wrapped = (nextIndex + values.length) % values.length;
    onChange(values[wrapped] ?? null);
    refs.current[wrapped]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(values.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div role="tablist" aria-label={legend} className="flex flex-wrap items-center gap-2">
      {scopeOptions(kids).map((option, index) => {
        const optionValue = option?.id ?? null;
        const selected = value === optionValue;
        return (
          <button
            key={optionValue ?? '__family__'}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(optionValue)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`pill pill-action cursor-pointer ${selected ? 'pill-apricot' : ''}`}
          >
            <ScopeOptionLabel option={option} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The radiogroup — single choice, one tab stop, Up/Down/Left/Right + Home/End
 * move AND select the option per WAI-ARIA APG. The chosen option carries a
 * checkmark (a shape, not colour alone).
 */
function ScopeSelect({ kids, value, onChange, legend }: VariantProps) {
  const values = optionValues(kids);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const groupId = useId();

  function move(nextIndex: number) {
    const wrapped = (nextIndex + values.length) % values.length;
    onChange(values[wrapped] ?? null);
    refs.current[wrapped]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(values.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={legend}
      id={groupId}
      className="flex flex-wrap items-center gap-2"
    >
      {scopeOptions(kids).map((option, index) => {
        const optionValue = option?.id ?? null;
        const checked = value === optionValue;
        return (
          <button
            key={optionValue ?? '__family__'}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: a pill-styled radiogroup needs button+role=radio — a native <input type="radio"> can't carry the chip styling, the checkmark glyph, or the roving-tabindex APG keyboard model this group uses.
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(optionValue)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`pill pill-action cursor-pointer ${checked ? 'pill-apricot' : ''}`}
          >
            {checked ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
            <ScopeOptionLabel option={option} />
          </button>
        );
      })}
    </div>
  );
}
