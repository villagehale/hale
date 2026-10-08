import { ChevronLeft, Video } from 'lucide-react';
import type { ReactNode } from 'react';

/** CSS handset: thin even bezel, Dynamic Island, titanium edge. */
export function PhoneChat({ children }: { children: ReactNode }) {
  return (
    <div className="gallery-phone">
      <div className="gallery-phone-screen">
        <div className="gallery-phone-island" aria-hidden="true" />
        <div className="gallery-phone-status" aria-hidden="true">
          <span>9:41</span>
          <svg viewBox="0 0 70 12" fill="currentColor" aria-hidden="true">
            <rect x="0" y="8" width="3" height="4" rx="0.8" />
            <rect x="5" y="6" width="3" height="6" rx="0.8" />
            <rect x="10" y="3" width="3" height="9" rx="0.8" />
            <rect x="15" width="3" height="12" rx="0.8" />
            <path d="M24 4a10 10 0 0 1 14 0l-1.5 1.5a8 8 0 0 0-11 0Zm3 3a6 6 0 0 1 8 0l-1.5 1.5a4 4 0 0 0-5 0Zm2 3 2 2 2-2a3 3 0 0 0-4 0Z" />
            <rect
              x="45"
              y="1"
              width="21"
              height="10"
              rx="3"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.5"
            />
            <rect x="47" y="3" width="17" height="6" rx="1.5" />
            <path d="M68 4v4c1-.4 1.5-1 1.5-2S69 4.4 68 4Z" />
          </svg>
        </div>
        {children}
        <div className="gallery-phone-nav" aria-hidden="true">
          <ChevronLeft />
          <Video />
        </div>
        <div className="gallery-phone-home" aria-hidden="true">
          <i />
        </div>
      </div>
    </div>
  );
}

export function TypingBubble() {
  return (
    <span className="chat-typing" data-motion-typing aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
