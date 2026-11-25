import stage from '~/components/hale/connect/connect.module.css';
import { NotesBar } from './founding-notes-bar';
import notes from './founding-notes.module.css';

/** Text tier on /founding, shown next to the founding join form. Style D Notes page. */
export function FreeJoinCard() {
  return (
    <section className={`${stage.card} ${stage.door} ${notes.paper}`} aria-label="Text">
      <div className={stage.act}>
        <NotesBar />
        <p className={`${stage.eyebrow} ${notes.kicker}`}>Text</p>
        <h1 className={`${stage.h1} ${notes.head} ${notes.num}`}>$0</h1>
        <p className={`${stage.lede} ${notes.lede}`}>No card needed.</p>
      </div>
    </section>
  );
}
