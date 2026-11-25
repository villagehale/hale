import notes from './founding-notes.module.css';

/** The Notes app's "‹ Notes" / "Done" chrome. Decorative: words live in CSS, hidden from readers. */
export function NotesBar() {
  return (
    <div className={notes.bar} aria-hidden="true">
      <span className={notes.back} />
      <span className={notes.done} />
    </div>
  );
}
