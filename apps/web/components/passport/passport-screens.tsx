import Link from 'next/link';
import { PassportFrame } from '~/components/passport/passport-frame';
import { StampBook } from '~/components/passport/stamp-book';
import {
  addPassportChildAction,
  familyShareAction,
  saveBasicsAction,
} from '~/lib/passport/actions';
import type { KidCard, PassportModel } from '~/lib/passport/read';

export function PassportHomeScreen({ model }: { model: PassportModel }) {
  return (
    <PassportFrame>
      <h1>Family</h1>
      <p className="pp-lede">Who Hale helps, and who can see it.</p>
      <div className="pp-grid">
        <section className="pp-card">
          <h2>Kids</h2>
          {model.children.length === 0 ? (
            <p className="pp-meta">Add a child and their passport starts empty.</p>
          ) : null}
          {model.children.map((child) => {
            const toCheck = child.stamps.filter((stamp) => stamp.inferred).length;
            const stamped = child.stamps.length - toCheck;
            return (
              <div className="pp-kid" key={child.id}>
                <div>
                  <b>{child.name}</b>
                  <span>{child.meta}</span>
                  <div className="pp-meta">
                    {stamped} stamp{stamped === 1 ? '' : 's'}
                    {toCheck > 0 ? ` · ${toCheck} to check` : ''}
                  </div>
                </div>
                <Link className="pp-open" href={`/family/${child.id}`} data-testid="open-passport">
                  Open passport
                </Link>
              </div>
            );
          })}
          <form action={addPassportChildAction} className="pp-fields">
            <b>+ Add a child</b>
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Date of birth
              <input name="dateOfBirth" type="date" required />
            </label>
            <button type="submit">Add</button>
          </form>
        </section>
        <div>
          <section className="pp-card">
            <h2>Parents and caregivers</h2>
            {model.members.map((member) => (
              <div className="pp-row" key={member.name}>
                <div>
                  <b>{member.name}</b>
                  <div className="pp-meta">{member.detail}</div>
                </div>
              </div>
            ))}
          </section>
          <section className="pp-card pp-share" style={{ marginTop: 16 }}>
            <h2>Sharing and privacy</h2>
            <form action={familyShareAction}>
              <input type="hidden" name="share" value={model.shareWithGroup ? 'false' : 'true'} />
              <b>Share with your group</b>
              <p>
                {model.shareWithGroup
                  ? 'On. Confirmed stamps are visible to your group as a first name, the activity, and the season.'
                  : 'Off. Nothing about your kids goes to the group.'}
              </p>
              <p>You can still share a single stamp from a kid’s page.</p>
              <button className="pp-text-btn" type="submit" data-testid="family-share">
                {model.shareWithGroup ? 'Turn off' : 'Turn on'}
              </button>
            </form>
          </section>
        </div>
      </div>
      {model.unassigned.length > 0 ? (
        <p className="pp-meta">{model.unassigned.length} stamp needs a child before it can land.</p>
      ) : null}
      <footer className="pp-foot">
        <span>
          Never sold. <a href="https://villagehale.com/privacy">Privacy policy</a>
        </span>
        <span>Hale /HAH-leh/ — Hawaiian for home.</span>
      </footer>
    </PassportFrame>
  );
}

export function PassportKidScreen({
  model,
  kid,
  initialStampId,
}: {
  model: PassportModel;
  kid: KidCard;
  initialStampId?: string | null;
}) {
  const stamped = kid.stamps.filter((stamp) => !stamp.inferred).length;
  const toCheck = kid.stamps.filter((stamp) => stamp.inferred);
  const counts = new Map<string, number>();
  for (const stamp of kid.stamps) counts.set(stamp.activity, (counts.get(stamp.activity) ?? 0) + 1);
  const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return (
    <PassportFrame>
      <Link className="pp-back" href="/family">
        Family
      </Link>
      <h1>{kid.name}</h1>
      <p className="pp-lede">
        {kid.name}’s passport: everything they’ve tried, stamped as it happens. You have the final
        say.
      </p>
      <section className="pp-card">
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
        {toCheck.length > 0 ? (
          <div>
            <p>
              {toCheck.length} stamp{toCheck.length === 1 ? '' : 's'} to check
            </p>
            <p className="pp-meta">
              Hale thinks these are {kid.name}’s. Nothing is stamped for sure until you say.
            </p>
            {toCheck.map((stamp) => (
              <div className="pp-row" key={stamp.id}>
                <div>
                  <b>
                    {stamp.activity}
                    {stamp.level ? ` · ${stamp.level}` : ''}
                  </b>
                  <div className="pp-meta">{stamp.sourceLabel}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <section className="pp-card" style={{ marginTop: 16 }}>
        <h2>Stamps · newest first</h2>
        <StampBook
          kid={kid}
          kids={model.children.map((child) => ({ id: child.id, name: child.name }))}
          initialStampId={initialStampId}
        />
      </section>
      <section className="pp-card" style={{ marginTop: 16 }}>
        <h2>Basics</h2>
        <form action={saveBasicsAction} className="pp-fields">
          <input type="hidden" name="childId" value={kid.id} />
          <p>
            {kid.age}
            {kid.born ? ` · ${kid.born}` : ''}
          </p>
          <label>
            Grade
            <input name="grade" defaultValue={kid.grade ?? ''} placeholder="Grade" />
          </label>
          <label>
            School day ends
            <input name="schoolDayEnds" defaultValue={kid.schoolDayEnds ?? ''} placeholder="3:20" />
          </label>
          <label>
            Notes
            <textarea name="notes" defaultValue={kid.notes ?? ''} rows={3} />
          </label>
          <button className="pp-primary" type="submit">
            Save basics
          </button>
        </form>
      </section>
      <section className="pp-card pp-share" style={{ marginTop: 16 }}>
        <h2>Who sees it</h2>
        <p>
          Only your family.
          {model.shareWithGroup
            ? ' Family sharing is on, so confirmed stamps can be seen by your group as a first name, the activity, and the season.'
            : ' Family-wide sharing is off, so your group sees nothing from this passport unless you share one stamp.'}
        </p>
        <Link href="/family">Family sharing settings</Link>
      </section>
      <footer className="pp-foot">
        <span>
          Never sold. <a href="https://villagehale.com/privacy">Privacy policy</a>
        </span>
        <span>Hale /HAH-leh/ — Hawaiian for home.</span>
      </footer>
    </PassportFrame>
  );
}
