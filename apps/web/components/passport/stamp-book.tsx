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
import type { KidCard, StampCard } from '~/lib/passport/read';

export function StampBook({
  kid,
  kids,
  initialStampId,
}: {
  kid: KidCard;
  kids: { id: string; name: string }[];
  initialStampId?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(initialStampId ?? null);
  const stamp =
    kid.stamps.find((item) => item.id === openId) ??
    kid.removed.find((item) => item.id === openId) ??
    null;
  return (
    <>
      <div className="pp-book" data-testid="stamp-book">
        {kid.stamps.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.inferred ? 'pp-cell is-inferred' : 'pp-cell'}
            data-testid="stamp"
            onClick={() => setOpenId(item.id)}
          >
            <StampMark
              id={item.id}
              icon={item.icon}
              kind={item.kind}
              inferred={item.inferred}
              top={item.top}
              bottom={item.face}
            />
            <b>{item.activity}</b>
            {item.progress ? <small>{item.progress}</small> : null}
            <small>{item.sourceLabel}</small>
            {item.inferred ? <span className="pp-check">Check</span> : null}
          </button>
        ))}
      </div>
      {kid.removed.length > 0 ? (
        <div className="pp-share">
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
        <StampSheet stamp={stamp} kid={kid} kids={kids} onClose={() => setOpenId(null)} />
      ) : null}
    </>
  );
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
  const [ready, setReady] = useState(false);
  const statusRef = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    setReady(true);
  }, []);
  // The sheet is the scroll container. After confirm or save, move the line
  // into that visible area. scrollIntoView alone can leave it on the outer page.
  useEffect(() => {
    const node = statusRef.current;
    if (!status || !node) return;
    const sheet = node.closest('.pp-sheet');
    if (!(sheet instanceof HTMLElement)) return;
    const padding = 24;
    const sheetRect = sheet.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop = sheetRect.top + Math.max(padding, (sheetRect.height - nodeRect.height) / 2);
    sheet.scrollTop += nodeRect.top - targetTop;
  }, [status]);
  const fields = (form: FormData) => {
    form.set('stampId', stamp.id);
    form.set('childId', childId);
    form.set('returnChildId', kid.id);
    return form;
  };
  const sheet = (
    <>
      <button className="pp-sheet-dim" type="button" aria-label="Close stamp" onClick={onClose} />
      <dialog className="pp-sheet" open aria-label={stamp.activity} data-testid="stamp-sheet">
        <div className="pp-grab" />
        <div className="pp-kid">
          <StampMark
            id={stamp.id}
            icon={stamp.icon}
            kind={stamp.kind}
            inferred={stamp.inferred}
            top={stamp.top}
            bottom={stamp.face}
          />
          <div>
            {stamp.inferred ? <div className="pp-check">Inferred · not stamped</div> : null}
            <h2>
              {stamp.activity}
              {stamp.level ? `, ${stamp.level}` : ''}
            </h2>
            <p className="pp-meta">
              {kid.name}
              {stamp.whenLabel ? ` · ${stamp.whenLabel}` : ''}
            </p>
          </div>
        </div>
        <div className="pp-src">
          <b>{stamp.sourceLabel}</b>
          {stamp.sourceDetail ? <span>{stamp.sourceDetail}</span> : null}
          {stamp.emailUrl ? (
            <a href={stamp.emailUrl} target="_blank" rel="noreferrer">
              Open the email
            </a>
          ) : null}
        </div>
        <form
          className="pp-fields"
          onSubmit={async (event) => {
            event.preventDefault();
            const result = await saveStampAction(fields(new FormData(event.currentTarget)));
            setStatus(result.status);
          }}
        >
          <label>
            Activity
            <input name="activity" defaultValue={stamp.activity} />
          </label>
          <label>
            Level or group
            <input name="level" defaultValue={stamp.level ?? ''} />
          </label>
          <div>
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
            <input name="when" defaultValue={stamp.whenLabel ?? stamp.progress ?? ''} />
          </label>
          <label>
            <input type="checkbox" name="shared" defaultChecked={stamp.shared} /> Share with your
            group
          </label>
          <p className="pp-meta">Off. Nobody sees this unless you turn it on.</p>
          <div className="pp-actions">
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
            <button type="submit">Save changes</button>
          </div>
          <output
            className="pp-status"
            data-testid="stamp-status"
            aria-live="polite"
            aria-atomic="true"
            ref={statusRef}
          >
            {status === 'preview' ? 'Preview — nothing was saved.' : status ? 'Saved.' : null}
          </output>
        </form>
        <div className="pp-actions">
          <form action={shareStampAction}>
            <input type="hidden" name="stampId" value={stamp.id} />
            <input type="hidden" name="childId" value={kid.id} />
            <input type="hidden" name="shared" value={stamp.shared ? 'false' : 'true'} />
            <button type="submit">{stamp.shared ? 'Stop sharing' : 'Share this stamp'}</button>
          </form>
          <form action={removeStampAction}>
            <input type="hidden" name="stampId" value={stamp.id} />
            <input type="hidden" name="childId" value={kid.id} />
            <button type="submit">Not {kid.name}’s</button>
          </form>
        </div>
      </dialog>
    </>
  );
  // The stamp card uses backdrop-filter, which makes it the containing block for
  // position:fixed. Portaling to the body is what lets the sheet cover the page.
  if (!ready) return null;
  return createPortal(sheet, document.body);
}
