import stage from '~/components/hale/connect/connect.module.css';

/** Text tier on /founding, shown next to the founding join form. */
export function FreeJoinCard() {
  return (
    <section className={`${stage.card} ${stage.door}`} aria-label="Text">
      <div className={stage.act}>
        <p className={stage.eyebrow}>Text</p>
        <h1 className={stage.h1}>$0/mo</h1>
        <p className={stage.lede}>No card needed.</p>
      </div>
    </section>
  );
}
