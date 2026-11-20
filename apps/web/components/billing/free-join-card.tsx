import stage from '~/components/hale/connect/connect.module.css';

/** Free tier on /founding, shown next to the founding join form. */
export function FreeJoinCard() {
  return (
    <section className={`${stage.card} ${stage.door}`} aria-label="Free">
      <div className={stage.act}>
        <p className={stage.eyebrow}>Free</p>
        <h1 className={stage.h1}>Everything Hale does is free for you.</h1>
        <p className={stage.lede}>
          Every feature, including new ones as they ship. There’s no plan to pick and nothing to
          pay.
        </p>
      </div>
    </section>
  );
}
