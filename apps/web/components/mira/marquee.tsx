interface MarqueeProps {
  items: string[];
}

/**
 * Slow horizontal ticker — used as a footer device on long pages.
 * Plays the items list twice so the slide loop is seamless.
 */
export function Marquee({ items }: MarqueeProps) {
  // Render the list twice so the keyframe slide loops seamlessly.
  // Suffix each run so React keys stay unique across the duplicated set.
  const tracked = [
    ...items.map((item) => ({ key: `a-${item}`, item })),
    ...items.map((item) => ({ key: `b-${item}`, item })),
  ];
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee-track">
        {tracked.map(({ key, item }) => (
          <span key={key} className="marquee-item">
            ※ {item}
          </span>
        ))}
      </div>
    </div>
  );
}
