'use client';

import { Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import { Field } from '~/components/ui/field';
import { addChildAction, editChildAction } from '~/lib/family/children-actions';
import type { ChildError } from '~/lib/family/children-input';

/** One child as the Family page already renders it, plus the DOB so edits prefill. */
export interface FamilyChild {
  id: string;
  name: string;
  dateOfBirth: string;
  stageLabel: string;
}

const ERROR_COPY: Record<ChildError, string> = {
  name_required: 'a name (or nickname) is needed.',
  dob_required: 'a date of birth is needed.',
  dob_invalid: "that date doesn't look right.",
  dob_future: "that's in the future — check the year.",
  dob_too_old: 'Hale is for children under eighteen.',
};

const PREVIEW_NOTE =
  "sign-in isn't configured in this preview, so nothing was saved.";

function today(): string {
  return new Date().toISOString().slice(0, 10);
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
                <div className="flex items-baseline justify-between gap-4">
                  <div>
                    <p className="font-display text-[1.5rem] leading-tight">{child.name}</p>
                    <p className="meta mt-1">{child.stageLabel}</p>
                  </div>
                  <button
                    type="button"
                    className="link meta inline-flex items-center gap-1.5"
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
  | { kind: 'error'; message: string };

function ChildForm({ mode, child, onDone, onCancel }: ChildFormProps) {
  const [name, setName] = useState(child?.name ?? '');
  const [dob, setDob] = useState(child?.dateOfBirth ?? '');
  const [interests, setInterests] = useState('');
  const [state, setState] = useState<FormState>({ kind: 'idle' });

  async function submit() {
    setState({ kind: 'saving' });
    const input = { name, dateOfBirth: dob, interests: mode === 'add' ? interests : undefined };
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
    if (result.status === 'not_found') {
      setState({ kind: 'error', message: 'that child is no longer in your family.' });
      return;
    }
    setState({ kind: 'error', message: ERROR_COPY[result.error] });
  }

  return (
    <Card className="md:col-span-2">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-baseline justify-between">
          <span className="eyebrow text-spruce">{mode === 'add' ? 'add a child' : 'edit child'}</span>
          <button
            type="button"
            className="link meta inline-flex items-center gap-1.5"
            onClick={onCancel}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
            cancel
          </button>
        </div>

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

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={state.kind === 'saving'} aria-live="polite">
            {state.kind === 'saving'
              ? 'saving…'
              : mode === 'add'
                ? 'add child'
                : 'save changes'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
