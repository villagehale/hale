'use client';

import { Camera, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useIsDesktop } from '~/components/hale/use-is-desktop';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import { Field } from '~/components/ui/field';
import { Modal } from '~/components/ui/modal';
import { childInitials } from '~/lib/family/child-initials';
import {
  addChildAction,
  editChildAction,
  removeChildAction,
} from '~/lib/family/children-actions';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';
import type { ChildError } from '~/lib/family/children-input';

/** One child as the Family page renders it: the DOB so edits prefill, the optional
 * last name (for real first+last initials, never a parent's surname — rule #1), and
 * the pre-signed avatar URL (or null for the initials fallback). */
export interface FamilyChild {
  id: string;
  name: string;
  lastName: string | null;
  dateOfBirth: string;
  stageLabel: string;
  avatarUrl: string | null;
}

const ERROR_COPY: Record<ChildError, string> = {
  name_required: 'a name (or nickname) is needed.',
  dob_required: 'a date of birth is needed.',
  dob_invalid: "that date doesn't look right.",
  dob_future: "that's in the future — check the year.",
  dob_too_old: 'Hale is for children under eighteen.',
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A child's avatar: the uploaded photo when present, else the monogram fallback
 * (first + last initial — rule #1: never a parent's surname). A photo that fails to
 * load (expired/removed object) degrades to the monogram rather than a broken image.
 * Decorative — the child's name is always shown as text alongside it.
 */
function ChildAvatar({
  url,
  name,
  lastName,
  size,
}: {
  url: string | null;
  name: string;
  lastName: string | null;
  size: 'sm' | 'lg';
}) {
  const [broken, setBroken] = useState(false);
  const dims = size === 'lg' ? 'h-20 w-20 text-2xl' : 'h-8 w-8 text-[0.8rem]';
  const showImage = url !== null && !broken;
  return (
    <span
      className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-apricot-tint font-bold text-[color:var(--color-brand)] ${dims}`}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        childInitials(name, lastName)
      )}
    </span>
  );
}

/**
 * The upload / replace / remove control for a child's photo, shown only in edit mode
 * (an avatar needs an existing child). Posts the bytes to the avatar route (which
 * byte-sniffs + caps server-side — rule #1), tracks the signed URL locally so the new
 * photo shows immediately, and surfaces honest copy for the reject cases.
 */
function ChildAvatarEditor({
  childId,
  initialUrl,
  name,
  lastName,
}: {
  childId: string;
  initialUrl: string | null;
  name: string;
  lastName: string | null;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/family/children/${childId}/avatar`, {
      method: 'POST',
      body: form,
    });
    setBusy(false);
    if (res.ok) {
      const { avatarUrl } = (await res.json()) as { avatarUrl: string };
      setUrl(avatarUrl);
      return;
    }
    if (res.status === 415) {
      setError('that image type isn’t supported — use a JPEG, PNG, or WebP.');
    } else if (res.status === 413) {
      setError('that photo is too large — keep it under 5 MB.');
    } else if (res.status === 429) {
      setError('too many uploads just now — try again in a bit.');
    } else {
      setError('couldn’t upload that photo. try again.');
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/family/children/${childId}/avatar`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) {
      setUrl(null);
      return;
    }
    setError('couldn’t remove that photo. try again.');
  }

  return (
    <div className="flex items-center gap-4">
      <ChildAvatar url={url} name={name} lastName={lastName} size="lg" />
      <div className="flex flex-col gap-1.5">
        <input
          ref={inputRef}
          type="file"
          // A hint only — the server byte-sniffs the real type, never trusting this.
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) upload(file);
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="link meta inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Camera size={14} strokeWidth={2} aria-hidden="true" />
            {busy ? 'working…' : url ? 'change photo' : 'add photo'}
          </button>
          {url ? (
            <button
              type="button"
              className="link meta text-apricot-deep inline-flex items-center gap-1.5"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
              remove
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="meta text-apricot-deep" role="alert">
            {error}
          </p>
        ) : (
          <p className="meta text-slate-green">optional · JPEG, PNG, or WebP, up to 5 MB</p>
        )}
      </div>
    </div>
  );
}

export function FamilyChildren({ kids }: { kids: FamilyChild[] }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      {kids.length === 0 ? (
        <p className="font-display text-[1.5rem]">no kids added yet</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {kids.map((child) =>
            editingId === child.id ? (
              <ChildForm
                key={child.id}
                mode="edit"
                child={child}
                onDone={() => setEditingId(null)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <Card key={child.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <ChildAvatar
                      url={child.avatarUrl}
                      name={child.name}
                      lastName={child.lastName}
                      size="sm"
                    />
                    <div className="min-w-0" data-hale-pii>
                      <p className="font-display text-[1.5rem] leading-tight break-words">
                        {child.name}
                      </p>
                      <p className="meta mt-1">{child.stageLabel}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="link meta inline-flex shrink-0 items-center gap-1.5"
                    onClick={() => {
                      setAdding(false);
                      setEditingId(child.id);
                    }}
                  >
                    <Pencil size={14} strokeWidth={2} aria-hidden="true" />
                    edit
                  </button>
                </div>
              </Card>
            ),
          )}
        </div>
      )}

      {adding ? (
        <ChildForm mode="add" onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : (
        <Button
          variant="secondary"
          icon={Plus}
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        >
          add a child
        </Button>
      )}
    </div>
  );
}

type ChildFormProps =
  | { mode: 'add'; child?: undefined; onDone: () => void; onCancel: () => void }
  | { mode: 'edit'; child: FamilyChild; onDone: () => void; onCancel: () => void };

type FormState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'preview' }
  | { kind: 'signed_out' }
  | { kind: 'error'; message: string };

function ChildForm({ mode, child, onDone, onCancel }: ChildFormProps) {
  const [name, setName] = useState(child?.name ?? '');
  const [lastName, setLastName] = useState(child?.lastName ?? '');
  const [dob, setDob] = useState(child?.dateOfBirth ?? '');
  const [interests, setInterests] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function submit() {
    setState({ kind: 'saving' });
    // lastName is prefilled from the stored value, so sending it on every save
    // preserves it (or applies a real edit) — it never wipes a name set elsewhere.
    const input = {
      name,
      lastName,
      dateOfBirth: dob,
      interests: mode === 'add' ? interests : undefined,
    };
    const result =
      mode === 'add'
        ? await addChildAction(input)
        : await editChildAction(child.id, input);

    if (result.status === 'added' || result.status === 'updated') {
      onDone();
      return;
    }
    if (result.status === 'preview') {
      setState({ kind: 'preview' });
      return;
    }
    if (result.status === 'unauthenticated') {
      setState({ kind: 'signed_out' });
      return;
    }
    if (result.status === 'not_found') {
      setState({ kind: 'error', message: 'that child is no longer in your family.' });
      return;
    }
    setState({ kind: 'error', message: ERROR_COPY[result.error] });
  }

  async function remove() {
    if (mode !== 'edit') {
      return;
    }
    setState({ kind: 'saving' });
    const result = await removeChildAction(child.id);
    if (result.status === 'removed') {
      onDone();
      return;
    }
    if (result.status === 'preview') {
      setState({ kind: 'preview' });
      return;
    }
    if (result.status === 'unauthenticated') {
      setState({ kind: 'signed_out' });
      return;
    }
    setState({ kind: 'error', message: 'that child is no longer in your family.' });
  }

  const title = mode === 'add' ? 'add a child' : 'edit child';
  const isDesktop = useIsDesktop();

  const form = (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* On desktop the Modal supplies the title + close; inline (< 1024px) keeps
         * this in-card header + cancel — presentation only, same form + actions. */}
        {isDesktop ? null : (
          <div className="flex items-baseline justify-between">
            <span className="eyebrow text-spruce">{title}</span>
            <button
              type="button"
              className="link meta inline-flex items-center gap-1.5"
              onClick={onCancel}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
              cancel
            </button>
          </div>
        )}

        {/* A photo needs an existing child, so the avatar control is edit-only; a
         * new child is created first, then given a photo. */}
        {mode === 'edit' ? (
          <ChildAvatarEditor
            childId={child.id}
            initialUrl={child.avatarUrl}
            name={name}
            lastName={lastName}
          />
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field
            label="name or nickname"
            name="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="maya"
            autoComplete="off"
            spellCheck={false}
          />
          <Field
            label="last name (optional)"
            name="lastName"
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.currentTarget.value)}
            placeholder="vega"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field
            label="date of birth"
            name="dateOfBirth"
            type="date"
            required
            value={dob}
            max={today()}
            onChange={(e) => setDob(e.currentTarget.value)}
            autoComplete="bday"
          />
        </div>

        {mode === 'add' ? (
          <Field
            label="interests (optional)"
            name="interests"
            type="text"
            hint="comma-separated — helps Hale find local things, e.g. swimming, music"
            value={interests}
            onChange={(e) => setInterests(e.currentTarget.value)}
            placeholder="swimming, music"
            autoComplete="off"
          />
        ) : null}

        {state.kind === 'error' ? (
          <p className="meta text-apricot-deep" role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'preview' ? (
          <output className="meta text-slate-green block">{PREVIEW_NOTE}</output>
        ) : null}
        {state.kind === 'signed_out' ? (
          <output className="meta text-slate-green block">{SIGNED_OUT_NOTE}</output>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={state.kind === 'saving'} aria-live="polite">
            {state.kind === 'saving'
              ? 'saving…'
              : mode === 'add'
                ? 'add child'
                : 'save changes'}
          </Button>
          {mode === 'edit' ? (
            confirmingRemove ? (
              <span className="flex flex-wrap items-center gap-3">
                <span className="meta">
                  remove <span data-hale-pii>{child.name}</span>?
                </span>
                <button
                  type="button"
                  className="link meta text-apricot-deep inline-flex items-center gap-1.5"
                  onClick={remove}
                  disabled={state.kind === 'saving'}
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                  yes, remove
                </button>
                <button
                  type="button"
                  className="link meta"
                  onClick={() => setConfirmingRemove(false)}
                >
                  keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="link meta inline-flex items-center gap-1.5 ml-auto"
                onClick={() => setConfirmingRemove(true)}
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                remove
              </button>
            )
          ) : null}
        </div>
      </form>
  );

  if (isDesktop) {
    return (
      <Modal title={title} onClose={onCancel}>
        {form}
      </Modal>
    );
  }

  return <Card className="md:col-span-2">{form}</Card>;
}
