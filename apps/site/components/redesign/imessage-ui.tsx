import { logoSrc } from './assets';

/** Glass back circle for the iOS 26 conversation header. */
export function ImBack() {
  return (
    <span className="im-back" aria-hidden="true">
      <svg
        viewBox="0 0 10 17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8.5 1.5 1.5 8.5l7 7" />
      </svg>
    </span>
  );
}

/** iOS 26 composer: glass plus, iMessage capsule, mic. */
export function ImCompose() {
  return (
    <div className="im-compose" aria-hidden="true">
      <span className="plus">
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M8 2v12M2 8h12" />
        </svg>
      </span>
      <span className="field">
        iMessage
        <svg viewBox="0 0 12 17" fill="currentColor" aria-hidden="true">
          <rect x="3.5" y="0.5" width="5" height="10" rx="2.5" />
          <path
            d="M1.2 8a4.8 4.8 0 0 0 9.6 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <path d="M6 13v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    </div>
  );
}

/** 1:1 contact header. The chevron is the name capsule's ::after. */
export function HaleHead() {
  return (
    <div className="im-head">
      <span className="im-head-av">
        <img src={logoSrc} alt="" />
      </span>
      <span className="im-name">Hale</span>
    </div>
  );
}

/** One-line date header for a 1:1 crop. */
export function OneStamp({ today, time }: { today: string; time: string }) {
  return (
    <div className="im-stamp">
      <b>{today}</b> {time}
    </div>
  );
}

/** Avatar stack: a monogram, Hale, a monogram. */
export function StackAvatars({ left, right }: { left: string; right: string }) {
  return (
    <span className="im-head-av">
      <span className="im-mono">{left}</span>
      <img src={logoSrc} alt="" />
      <span className="im-mono">{right}</span>
    </span>
  );
}
