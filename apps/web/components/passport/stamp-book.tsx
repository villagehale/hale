'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StampMark } from '~/components/passport/stamp-mark';
import {
  confirmStampAction,
  removeStampAction,
  saveStampAction,
  shareStampAction,
  undoStampAction,
} from '~/lib/passport/actions';
import { glueMonthDay } from '~/lib/passport/month-day';
import { sortStampsNewestFirst } from '~/lib/passport/order';
import type { KidCard, StampCard } from '~/lib/passport/read';

export function StampBook({
  kid,
  kids,
  initialStampId,
  openId,
  onOpenId,
}: {
  kid: KidCard;
  kids: { id: string; name: string }[];
  initialStampId?: string | null;
  openId?: string | null;
  onOpenId?: (id: string | null) => void;
}) {
  const [localId, setLocalId] = useState<string | null>(initialStampId ?? null);
  const current = openId === undefined ? localId : openId;
  const setOpen = onOpenId ?? setLocalId;
  const stamps = sortStampsNewestFirst(kid.stamps);
  const stamp =
    stamps.find((item) => item.id === current) ??
    kid.removed.find((item) => item.id === current) ??
    null;
  return (
    <>
      <div className="pp-book" data-testid="stamp-book">
        {stamps.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.inferred ? 'pp-cell is-inferred' : 'pp-cell'}
            data-testid="stamp"
            data-stamp-id={item.id}
            onClick={() => setOpen(item.id)}
          >
            <StampMark
              id={item.id}
              slot="cell"
              icon={item.icon}
              kind={item.kind}
              inferred={item.inferred}
              top={item.top}
              bottom={item.face}
            />
            <b>{item.activity}</b>
            {item.progress ? <small>{item.progress}</small> : null}
            <small>
              {item.inferred ? <span className="pp-check">Check</span> : null}
              {glueMonthDay(item.sourceLabel)}
            </small>
          </button>
        ))}
      </div>
      <div className="pp-legend">
        <span>
          <i className="pp-lg" />
          Confirmed
        </span>
        <span>
          <i className="pp-lg is-dashed" />
          Inferred, waiting on you
        </span>
      </div>
      {kid.removed.length > 0 ? (
        <div className="pp-share-copy">
          {kid.removed.map((item) => (
            <form key={item.id} action={undoStampAction}>
              <input type="hidden" name="stampId" value={item.id} />
              <input type="hidden" name="childId" value={kid.id} />
              <p>
                {item.activity} was removed.{' '}
                <button className="pp-text-btn" type="submit">
                  Undo
                </button>
              </p>
            </form>
          ))}
        </div>
      ) : null}
      {stamp ? (
        <StampSheet
          key={stamp.id}
          stamp={stamp}
          kid={kid}
          kids={kids}
          onClose={() => {
            clearStampQuery();
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

function clearStampQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('stamp')) return;
  url.searchParams.delete('stamp');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function StampSheet({
  stamp,
  kid,
  kids,
  onClose,
}: {
  stamp: StampCard;
  kid: KidCard;
  kids: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [childId, setChildId] = useState(stamp.childId ?? kid.id);
  const [status, setStatus] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const formId = `stamp-fields-${stamp.id}`;
  const titleId = `stamp-title-${stamp.id}`;
  useEffect(() => {
    const main = document.getElementById('main-content');
    const shell = main?.parentElement?.parentElement;
    const surface = document.querySelector('[data-testid="interest-passport"]');
    const node = shell instanceof HTMLElement ? shell : surface;
    setHost(node instanceof HTMLElement ? node : null);
  }, []);
  useEffect(() => {
    if (!host) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnTo = document.querySelector<HTMLElement>(
      `[data-stamp-id="${CSS.escape(stamp.id)}"]`,
    );
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const dismiss = () => onCloseRef.current();
    const onCancel = (event: Event) => {
      event.preventDefault();
      dismiss();
    };
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) dismiss();
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('click', onClick);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onClick);
      if (dialog.open) dialog.close();
      returnTo?.focus();
    };
  }, [host, stamp.id]);
  const fields = (form: FormData) => {
    form.set('stampId', stamp.id);
    form.set('childId', childId);
    form.set('returnChildId', kid.id);
    return form;
  };
  const statusText = status === 'preview' ? 'Preview — nothing was saved.' : status ? 'Saved.' : '';
  const sheet = (
    <dialog
      ref={dialogRef}
      className="pp-sheet"
      aria-labelledby={titleId}
      data-testid="stamp-sheet"
    >
      <button
        ref={closeRef}
        className="pp-sheet-x"
        type="button"
        aria-label="Close"
        onClick={onClose}
      >
        <CloseIcon />
      </button>
      <div className="pp-sheet-body">
        <form
          id={formId}
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await saveStampAction(fields(new FormData(event.currentTarget)));
            setStatus(result.status);
          }}
        >
          <div className="pp-grab" />
          <div className="pp-top">
            <StampMark
              id={stamp.id}
              slot="sheet"
              icon={stamp.icon}
              kind={stamp.kind}
              inferred={stamp.inferred}
              top={stamp.top}
              bottom={stamp.face}
            />
            <div>
              {stamp.inferred ? <div className="pp-check">Inferred · not stamped</div> : null}
              <h2 id={titleId}>
                {stamp.activity}
                {stamp.level ? `, ${stamp.level}` : ''}
              </h2>
              <p className="pp-meta">
                {kid.name}
                {(stamp.cadence ?? stamp.whenLabel) ? ` · ${stamp.cadence ?? stamp.whenLabel}` : ''}
              </p>
            </div>
          </div>
          <div className="pp-src">
            <MailIcon />
            <div>
              <b>{glueMonthDay(stamp.sourceLabel)}</b>
              {stamp.sourceDetail ? <span>{glueMonthDay(stamp.sourceDetail)}</span> : null}
              {stamp.emailUrl ? (
                <a href={stamp.emailUrl} target="_blank" rel="noreferrer">
                  Open the email
                </a>
              ) : null}
            </div>
          </div>
          <div className="pp-fields">
            <label>
              Activity
              <input className="pp-in" name="activity" defaultValue={stamp.activity} />
            </label>
            <label>
              Level or group
              <input className="pp-in" name="level" defaultValue={stamp.level ?? ''} />
            </label>
            <div className="pp-field">
              Kid
              <div className="pp-kids">
                {kids.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={childId === item.id ? 'on' : ''}
                    onClick={() => setChildId(item.id)}
                  >
                    {item.name}
                  </button>
                ))}
                <button
                  type="button"
                  className={childId === 'both' ? 'on' : ''}
                  onClick={() => setChildId('both')}
                >
                  Both
                </button>
              </div>
            </div>
            <label>
              When
              <input
                className="pp-in"
                name="when"
                defaultValue={stamp.whenLabel ?? stamp.progress ?? ''}
              />
            </label>
          </div>
        </form>
        <form className="pp-share-row" action={shareStampAction}>
          <input type="hidden" name="stampId" value={stamp.id} />
          <input type="hidden" name="childId" value={kid.id} />
          <input type="hidden" name="shared" value={stamp.shared ? 'false' : 'true'} />
          <div>
            <b>Share with your group</b>
            <span>
              {stamp.shared
                ? 'On. Your group can see this stamp.'
                : 'Off. Nobody sees this unless you turn it on.'}
            </span>
          </div>
          <button
            className={stamp.shared ? 'pp-tog on' : 'pp-tog'}
            type="submit"
            aria-pressed={stamp.shared}
            aria-label="Share with your group"
          />
        </form>
      </div>
      <div className="pp-sheet-foot">
        <button
          className="pp-primary"
          type="button"
          onClick={async () => {
            const form = fields(new FormData());
            form.set('activity', stamp.activity);
            form.set('level', stamp.level ?? '');
            form.set('when', stamp.whenLabel ?? '');
            const result = await confirmStampAction(form);
            setStatus(result.status);
          }}
        >
          Confirm stamp
        </button>
        <div className="pp-two">
          <button type="submit" form={formId}>
            Save changes
          </button>
          <form action={removeStampAction}>
            <input type="hidden" name="stampId" value={stamp.id} />
            <input type="hidden" name="childId" value={kid.id} />
            <button className="pp-del" type="submit">
              Not {kid.name}’s
            </button>
          </form>
        </div>
        <div className="pp-status" data-testid="stamp-status" aria-live="polite" aria-atomic="true">
          {statusText}
        </div>
      </div>
    </dialog>
  );
  // Portal into the passport shell so the sheet inherits its colour tokens.
  // The shell is position:fixed without a filter, so the sheet still covers the viewport.
  if (!host) return null;
  return createPortal(sheet, host);
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
      <path d="M4 6.5 10 11l6-4.5" />
    </svg>
  );
}
