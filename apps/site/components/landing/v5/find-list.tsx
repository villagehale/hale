/**
 * The three finds, in the finder's own field shape.
 *
 * `ActivityPick` is name / ageFit / when / price / sourceName, and a null `when`
 * is the source not having published one. The lane's own comment says why that
 * field exists: "a parent who knows the program exists and can ring for the time
 * has been helped; a parent told nothing has not." So the missing time is
 * RENDERED — as the gap it is — rather than dropped or filled in.
 *
 * A list rather than cards: three picks with the same three fields are a list,
 * and the page already spends its one card grid on the four watched things.
 */
export interface Find {
  name: string;
  ageFit: string;
  /** In the source's own words, or null where the source had not published it. */
  when: string | null;
  /** WHOSE page this came off — the organisation, never a URL. Hale hands over
   *  no link for a web find, because a link it composes is a link it invented. */
  sourceName: string;
}

export function FindList({ finds, noTime }: { finds: Find[]; noTime: string }) {
  return (
    <ul className="v5-finds">
      {finds.map((find) => (
        <li key={find.name} className="v5-find">
          <p className="v5-find-name">{find.name}</p>
          <p className="v5-find-fit">{find.ageFit}</p>
          <p className={find.when === null ? 'v5-find-gap' : 'v5-find-when'}>
            {find.when ?? noTime}
          </p>
          <p className="v5-find-source">{find.sourceName}</p>
        </li>
      ))}
    </ul>
  );
}
