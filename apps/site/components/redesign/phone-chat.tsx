'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { ImCompose } from './imessage-ui';

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

/** Playback only follows new lines downward, so a typing handoff cannot jump the thread up. */
export function downwardPin(delta: number): number {
  return delta > 1 ? delta : 0;
}

/** A clip sought backward: the card restarted. */
export function playbackRewound(previous: number, current: number): boolean {
  return current < previous;
}

/** True when any playing clip jumped backward since the last sample. */
export function rewindClips(
  previous: ReadonlyMap<Animation, number>,
  current: ReadonlyMap<Animation, number>,
): boolean {
  for (const [clip, time] of current) {
    const before = previous.get(clip);
    if (before !== undefined && playbackRewound(before, time)) return true;
  }
  return false;
}

function visibleEnds(thread: HTMLElement): { opacity: number; bottom: number }[] {
  const nodes: { opacity: number; bottom: number }[] = [];
  // The typing balloon is absolutely positioned over its bubble. Follow the
  // balloon: the bubble stays in flow at full height.
  for (const node of thread.querySelectorAll<HTMLElement>(
    '.im-stamp, .im-who, .im-b, .im-status, .im-typing',
  )) {
    nodes.push({
      opacity: Number.parseFloat(getComputedStyle(node).opacity),
      bottom: node.getBoundingClientRect().bottom,
    });
  }
  return nodes;
}

function clipTimes(thread: HTMLElement): Map<Animation, number> {
  const times = new Map<Animation, number>();
  for (const node of [thread, ...thread.querySelectorAll<HTMLElement>('*')]) {
    for (const clip of node.getAnimations?.() ?? []) {
      const time = clip.currentTime;
      if (typeof time === 'number') times.set(clip, time);
    }
  }
  return times;
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
  const delta = downwardPin(threadPinDelta(end, thread.getBoundingClientRect().bottom, pad));
  if (delta !== 0) thread.scrollTop += delta;
}

/** CSS handset: thin even bezel, Dynamic Island, titanium edge. */
export function PhoneChat({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const phone = ref.current;
    const thread = phone?.querySelector<HTMLElement>('.im-phone-thread');
    if (!phone || !thread) return;
    let stuck = true;
    let pinning = false;
    let frame = 0;
    let timer = 0;
    let watching = false;
    let lastTop = thread.scrollTop;
    let times = clipTimes(thread);

    const resetThread = () => {
      stuck = true;
      pinning = true;
      lastTop = 0;
      thread.scrollTop = 0;
      lastTop = thread.scrollTop;
      pinning = false;
    };
    const pin = () => {
      const next = clipTimes(thread);
      if (rewindClips(times, next)) resetThread();
      times = next;
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
    const gallery = phone.closest('[data-chat-gallery]');
    const onGallery = () => {
      if (phone.closest('.gallery-slide')?.getAttribute('data-gallery-active') !== 'true') return;
      // The replay seek lands in an earlier listener. Sample after it so the
      // next frame does not treat the same rewind as a second reset.
      times = clipTimes(thread);
      resetThread();
    };
    gallery?.addEventListener('hale:gallerychange', onGallery);
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
      gallery?.removeEventListener('hale:gallerychange', onGallery);
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
        <ImCompose />
        <div className="gallery-phone-home" aria-hidden="true">
          <i />
        </div>
      </div>
    </div>
  );
}

export function TypingBubble() {
  return (
    <span className="im-typing" data-motion-typing aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
