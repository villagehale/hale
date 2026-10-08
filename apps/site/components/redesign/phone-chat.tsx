'use client';

import { ChevronLeft, Video } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

const VISIBLE_OPACITY = 0.05;

/** Last in-flow bubble that has actually appeared. Tree order, so a later line wins. */
export function lastVisibleBottom(
  nodes: readonly { opacity: number; bottom: number }[],
): number | null {
  let end: number | null = null;
  for (const node of nodes) {
    if (node.opacity > VISIBLE_OPACITY) end = node.bottom;
  }
  return end;
}

/** Positive when the visible end sits below the thread's padding edge. */
export function threadPinDelta(
  endBottom: number,
  threadBottom: number,
  paddingBottom: number,
): number {
  return endBottom - (threadBottom - paddingBottom);
}

function visibleEnds(thread: HTMLElement): { opacity: number; bottom: number }[] {
  const nodes: { opacity: number; bottom: number }[] = [];
  for (const node of thread.querySelectorAll<HTMLElement>(
    '.hs-stamp, .hs-who, .hs-msg, .hs-did, .chat-typing',
  )) {
    const typing = node.classList.contains('chat-typing');
    const box = typing ? (node.closest('.hs-row') ?? node) : node;
    nodes.push({
      opacity: Number.parseFloat(getComputedStyle(node).opacity),
      bottom: box.getBoundingClientRect().bottom,
    });
  }
  return nodes;
}

function running(thread: HTMLElement): boolean {
  const nodes = [thread, ...thread.querySelectorAll<HTMLElement>('*')];
  return nodes.some((node) => node.getAnimations?.().some((clip) => clip.playState === 'running'));
}

/** Keep the latest visible line on the padding edge, like iMessage. */
function pinThread(thread: HTMLElement) {
  if (thread.clientHeight === 0) return;
  const end = lastVisibleBottom(visibleEnds(thread));
  if (end === null) return;
  const pad = Number.parseFloat(getComputedStyle(thread).paddingBottom) || 0;
  const delta = threadPinDelta(end, thread.getBoundingClientRect().bottom, pad);
  if (Math.abs(delta) > 1) thread.scrollTop += delta;
}

/** CSS handset: thin even bezel, Dynamic Island, titanium edge. */
export function PhoneChat({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const phone = ref.current;
    const thread = phone?.querySelector<HTMLElement>('.hs-thread');
    if (!phone || !thread) return;
    let stuck = true;
    let pinning = false;
    let frame = 0;
    let timer = 0;
    let watching = false;
    let lastTop = thread.scrollTop;

    const pin = () => {
      if (!stuck) return;
      pinning = true;
      pinThread(thread);
      lastTop = thread.scrollTop;
      pinning = false;
    };
    const beat = () => {
      pin();
      if (watching && running(thread)) frame = requestAnimationFrame(beat);
      else frame = 0;
    };
    const kick = () => {
      if (!watching || frame) return;
      beat();
    };
    const onScroll = () => {
      if (pinning) return;
      const delta = thread.scrollTop - lastTop;
      lastTop = thread.scrollTop;
      if (delta < -4) stuck = false;
      if (thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 12) stuck = true;
    };
    const io = new IntersectionObserver(([entry]) => {
      watching = Boolean(entry?.isIntersecting);
      window.clearInterval(timer);
      if (!watching) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      kick();
      timer = window.setInterval(kick, 120);
    });
    io.observe(phone);
    thread.addEventListener('scroll', onScroll, { passive: true });
    pin();
    const initial = requestAnimationFrame(pin);
    const resize = new ResizeObserver(() => {
      pin();
      if (watching) kick();
    });
    resize.observe(thread);
    return () => {
      window.clearInterval(timer);
      cancelAnimationFrame(initial);
      if (frame) cancelAnimationFrame(frame);
      io.disconnect();
      resize.disconnect();
      thread.removeEventListener('scroll', onScroll);
    };
  }, []);

  return (
    <div className="gallery-phone" ref={ref}>
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
