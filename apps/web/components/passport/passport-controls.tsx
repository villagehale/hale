'use client';

import Link from 'next/link';
import { useState } from 'react';
import { StampBook } from '~/components/passport/stamp-book';
import { StampMark } from '~/components/passport/stamp-mark';
import {
  addPassportChildAction,
  familyShareAction,
  saveBasicsAction,
} from '~/lib/passport/actions';
import { glueMonthDay } from '~/lib/passport/month-day';
import { sortStampsNewestFirst } from '~/lib/passport/order';
import type { KidCard, PassportModel } from '~/lib/passport/read';

export function FamilyBoard({ model }: { model: PassportModel }) {
  return (
    <div className="pp-grid">
      <section className="pp-card">
        <h2>Kids</h2>
        {model.children.length === 0 ? (
          <p className="pp-meta">Add a child and their passport starts empty.</p>
        ) : null}
        {model.children.map((child) => (
          <KidRow key={child.id} child={child} />
        ))}
        <AddChild />
      </section>
      <div className="pp-col">
        <section className="pp-card">
          <h2>Parents and caregivers</h2>
          {model.members.map((member) => (
            <MemberRow key={member.name} name={member.name} detail={member.detail} />
          ))}
          <InviteSomeone />
        </section>
        <section className="pp-card">
          <h2>Sharing and privacy</h2>
          <form action={familyShareAction} className="pp-share-row" style={{ marginTop: 0 }}>
            <input type="hidden" name="share" value={model.shareWithGroup ? 'false' : 'true'} />
            <div>
              <b>Share with your group</b>
              <span>
                {model.shareWithGroup
                  ? 'On. Confirmed stamps are visible to your group as a first name, the activity, and the season.'
                  : 'Off. Nothing about your kids goes to the group.'}
              </span>
            </div>
            <button
              className={model.shareWithGroup ? 'pp-tog on' : 'pp-tog'}
              type="submit"
              aria-pressed={model.shareWithGroup}
              aria-label="Share with your group"
              data-testid="family-share"
            />
          </form>
          <p className="pp-share-copy">
            You can still share a single stamp from a kid’s page. Never sold.{' '}
            <a href="https://villagehale.com/privacy">Privacy policy</a>
          </p>
        </section>
      </div>
    </div>
  );
}

function KidRow({ child }: { child: KidCard }) {
  const toCheck = child.stamps.filter((stamp) => stamp.inferred).length;
  const stamped = child.stamps.length - toCheck;
  const minis = sortStampsNewestFirst(child.stamps).slice(0, 3);
  return (
    <div className="pp-kid">
      <div className="pp-fkt">
        <b>{child.name}</b>
        <span>{child.meta}</span>
        <div className="pp-meta">
          {stamped} stamp{stamped === 1 ? '' : 's'}
          {toCheck > 0 ? (
            <>
              {' · '}
              <span className="pp-amber">{toCheck} to check</span>
            </>
          ) : null}
        </div>
      </div>
      <Link
        className="pp-open"
        href={`/family/${child.id}`}
        data-testid="open-passport"
        aria-label={`Open ${child.name}'s passport, ${stamped} stamp${stamped === 1 ? '' : 's'}`}
      >
        <span className="pp-mini">
          {minis.map((stamp) => (
            <StampMark
              key={stamp.id}
              id={stamp.id}
              slot={`mini-${child.id}`}
              icon={stamp.icon}
              kind={stamp.kind}
              inferred={stamp.inferred}
              top={stamp.top}
              bottom={stamp.face}
              mini
            />
          ))}
        </span>
        <span className="pp-n">{stamped}</span>
        <span>Open passport</span>
        <Chevron />
      </Link>
    </div>
  );
}

function AddChild() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="pp-ghost pp-add" type="button" onClick={() => setOpen(true)}>
        + Add a child
      </button>
    );
  }
  return (
    <form action={addPassportChildAction} className="pp-fields pp-reveal">
      <b>+ Add a child</b>
      <label>
        Name
        <input className="pp-in" name="name" required />
      </label>
      <label>
        Date of birth
        <input className="pp-in" name="dateOfBirth" type="date" required />
      </label>
      <button className="pp-ghost" type="submit">
        Add
      </button>
    </form>
  );
}

function MemberRow({ name, detail }: { name: string; detail: string }) {
  const [editing, setEditing] = useState(false);
  const you = name.includes('(you)');
  return (
    <div className="pp-row">
      <div>
        <b>{name}</b>
        <div className="pp-meta">{detail}</div>
        {editing ? <p className="pp-meta">Preview — nothing was saved.</p> : null}
      </div>
      {you ? null : (
        <button className="pp-ghost" type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      )}
    </div>
  );
}

function InviteSomeone() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  if (!open) {
    return (
      <button className="pp-ghost pp-add" type="button" onClick={() => setOpen(true)}>
        + Invite someone
      </button>
    );
  }
  return (
    <form
      className="pp-reveal"
      onSubmit={(event) => {
        event.preventDefault();
        setSent(true);
      }}
    >
      <label className="pp-field">
        Name
        <input className="pp-in" name="name" required />
      </label>
      <button className="pp-ghost" type="submit">
        Send invite
      </button>
      {sent ? <p className="pp-meta">Preview — nothing was saved.</p> : null}
    </form>
  );
}

export function KidPassport({
  model,
  kid,
  initialStampId,
}: {
  model: PassportModel;
  kid: KidCard;
  initialStampId?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(initialStampId ?? null);
  const stamped = kid.stamps.filter((stamp) => !stamp.inferred).length;
  const toCheck = kid.stamps.filter((stamp) => stamp.inferred);
  const counts = new Map<string, number>();
  for (const stamp of kid.stamps) counts.set(stamp.activity, (counts.get(stamp.activity) ?? 0) + 1);
  const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const kids = model.children.map((child) => ({ id: child.id, name: child.name }));
  return (
    <div className="pp-kid-layout">
      <div className="pp-col">
        <section className="pp-card pp-stamps">
          <h2>Stamps · newest first</h2>
          <StampBook
            kid={kid}
            kids={kids}
            initialStampId={initialStampId}
            openId={openId}
            onOpenId={setOpenId}
          />
        </section>
        <BasicsCard kid={kid} />
      </div>
      <div className="pp-col">
        <section className="pp-card pp-glance">
          <h2>At a glance</h2>
          <div className="pp-stats">
            <div>
              <b>{stamped}</b>
              <span>stamped</span>
            </div>
            <div>
              <b>{toCheck.length}</b>
              <span>to check</span>
            </div>
            <div>
              <b>{most ?? '—'}</b>
              <span>most stamps</span>
            </div>
          </div>
        </section>
        {toCheck.length > 0 ? (
          <section className="pp-card pp-tocheck">
            <h2>
              <span className="pp-dot" />
              {toCheck.length} stamp{toCheck.length === 1 ? '' : 's'} to check
            </h2>
            <p className="pp-share-copy" style={{ marginTop: 0 }}>
              Hale thinks these are {kid.name}’s. Nothing is stamped for sure until you say.
            </p>
            {toCheck.map((stamp) => (
              <div className="pp-crow" key={stamp.id}>
                <h3>
                  {stamp.activity}
                  {stamp.level ? ` · ${stamp.level}` : ''}
                </h3>
                <p className="pp-meta">{glueMonthDay(stamp.sourceLabel)}</p>
                <div className="pp-btns">
                  <button className="pp-primary" type="button" onClick={() => setOpenId(stamp.id)}>
                    Confirm
                  </button>
                  <button className="pp-ghost" type="button" onClick={() => setOpenId(stamp.id)}>
                    Fix
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
        <section className="pp-card pp-who">
          <h2>Who sees it</h2>
          <p className="pp-share-copy" style={{ marginTop: 0 }}>
            Only your family.{' '}
            {model.shareWithGroup
              ? 'Family sharing is on, so confirmed stamps can be seen by your group as a first name, the activity, and the season.'
              : `Family-wide sharing is off, so your group sees nothing from ${kid.name} unless you share one stamp.`}
          </p>
          <Link className="pp-ghost pp-add" href="/family">
            Family sharing settings
          </Link>
        </section>
      </div>
    </div>
  );
}

function BasicsCard({ kid }: { kid: KidCard }) {
  const [editing, setEditing] = useState<'grade' | 'notes' | null>(null);
  return (
    <section className="pp-card pp-basics">
      <h2>Basics</h2>
      <div className="pp-row">
        <div>
          <b>{kid.age}</b>
          <div className="pp-meta">{kid.born}</div>
        </div>
        <button className="pp-ghost" type="button" aria-label={`Edit ${kid.name}’s age`}>
          Edit
        </button>
      </div>
      <div className="pp-row">
        <div>
          <b>{kid.grade ?? 'Grade'}</b>
          {kid.schoolDayEnds ? (
            <div className="pp-meta">School day ends {kid.schoolDayEnds}</div>
          ) : kid.grade === 'Daycare' ? null : (
            <div className="pp-meta">School day</div>
          )}
          {editing === 'grade' ? (
            <form action={saveBasicsAction} className="pp-reveal">
              <input type="hidden" name="childId" value={kid.id} />
              <input type="hidden" name="notes" value={kid.notes ?? ''} />
              <label className="pp-field">
                Grade
                <input className="pp-in" name="grade" defaultValue={kid.grade ?? ''} />
              </label>
              <label className="pp-field">
                School day ends
                <input
                  className="pp-in"
                  name="schoolDayEnds"
                  defaultValue={kid.schoolDayEnds ?? ''}
                />
              </label>
              <button className="pp-ghost" type="submit">
                Save
              </button>
            </form>
          ) : null}
        </div>
        <button className="pp-ghost" type="button" onClick={() => setEditing('grade')}>
          Edit
        </button>
      </div>
      <div className="pp-row">
        <div>
          <b>Notes</b>
          <div className="pp-meta">{kid.notes ?? 'None yet.'}</div>
          {editing === 'notes' ? (
            <form action={saveBasicsAction} className="pp-reveal">
              <input type="hidden" name="childId" value={kid.id} />
              <input type="hidden" name="grade" value={kid.grade ?? ''} />
              <input type="hidden" name="schoolDayEnds" value={kid.schoolDayEnds ?? ''} />
              <label className="pp-field">
                Notes
                <textarea className="pp-in" name="notes" defaultValue={kid.notes ?? ''} rows={3} />
              </label>
              <button className="pp-ghost" type="submit">
                Save
              </button>
            </form>
          ) : null}
        </div>
        <button className="pp-ghost" type="button" onClick={() => setEditing('notes')}>
          Edit
        </button>
      </div>
    </section>
  );
}

function Chevron() {
  return (
    <svg
      className="pp-chevron"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M8 5.5 12.5 10 8 14.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
