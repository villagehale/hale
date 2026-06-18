'use client';

import { useId, useState } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';

type BaseProps = {
  label: string;
  /** Help text shown under the label until an error replaces it. */
  hint?: ReactNode;
  /**
   * Validate the current value on blur. Return an error string to mark the
   * field invalid, or null when valid. Native constraints (required, type,
   * pattern, min/max) are checked first via the element's own validity.
   */
  validate?: (value: string) => string | null;
};

type InputProps = BaseProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { multiline?: false };

type TextareaProps = BaseProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { multiline: true };

type FieldProps = InputProps | TextareaProps;

/**
 * Labelled form field with on-blur validation. Native constraint validity is
 * checked first (so `required`, `type="email"`, `pattern` etc. work for free),
 * then the optional `validate` callback. The error replaces the hint and is
 * wired to the control via aria-describedby + aria-invalid.
 */
export function Field(props: FieldProps) {
  const { label, hint, validate, multiline, className, onBlur, ...control } = props as FieldProps & {
    onBlur?: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => void;
  };

  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [error, setError] = useState<string | null>(null);

  function runValidation(el: HTMLInputElement | HTMLTextAreaElement): void {
    if (!el.validity.valid) {
      setError(el.validationMessage);
      return;
    }
    setError(validate ? validate(el.value) : null);
  }

  const describedBy = error ? errorId : hint ? hintId : undefined;

  const shared = {
    id,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': describedBy,
    className: `field${error ? ' field-invalid' : ''}${className ? ` ${className}` : ''}`,
    onBlur: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      runValidation(event.currentTarget);
      onBlur?.(event);
    },
  };

  return (
    <div className="field-group">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {multiline ? (
        <textarea {...(control as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...shared} />
      ) : (
        <input {...(control as InputHTMLAttributes<HTMLInputElement>)} {...shared} />
      )}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
