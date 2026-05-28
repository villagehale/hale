interface MarqueeProps {
  items: string[];
}

/**
 * Slow horizontal ticker, used as a footer device on long pages. The
 * separator glyph is a small printer's diamond, which fits the almanac
 * idiom better than a bullet.
 */
export function Marquee({ items }: MarqueeProps) {
  const tracked = [
    ...items.map((item) => ({ key: `a-${item}`, item })),
    ...items.map((item) => ({ key: `b-${item}`, item })),
  ];
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee-track">
        {tracked.map(({ key, item }) => (
          <span key={key} className="marquee-item">
            <span className="text-madder mr-3">◆</span>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
