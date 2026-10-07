'use client';

import { useEffect, useRef, useState } from 'react';

/** Animate the existing examples once; their complete markup is the static fallback. */
export function HomeMotion({
  label = 'Replay example',
  description = 'Replay the family plan example',
}: {
  label?: string;
  description?: string;
} = {}) {
  const button = useRef<HTMLButtonElement>(null);
  const replay = useRef(() => {});
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const root = button.current?.closest('.rd');
    if (!root || !('IntersectionObserver' in window)) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let observer: IntersectionObserver | undefined;
    let scenes = new Map<Element, Animation[]>();
    const stop = () => {
      observer?.disconnect();
      for (const animations of scenes.values())
        for (const animation of animations) animation.cancel();
      scenes.clear();
      replay.current = () => {};
    };
    const setup = () => {
      stop();
      setEnabled(!reduced.matches);
      if (reduced.matches) return;
      const style = getComputedStyle(root);
      const duration = Number.parseFloat(style.getPropertyValue('--oct-motion-enter-ms'));
      const step = Number.parseFloat(style.getPropertyValue('--oct-motion-step-ms'));
      const chatStep = Number.parseFloat(style.getPropertyValue('--oct-chat-step-ms'));
      const distance = style.getPropertyValue('--oct-motion-distance').trim();
      const easing = style.getPropertyValue('--ease-breathe').trim();
      const isChat = (scene: Element) => scene.getAttribute('data-motion-scene') === 'chat';
      const centered = (scene: Element) => Boolean(scene.closest('[data-gallery-active="true"]'));
      const moving = (scene: Element) => Boolean(scene.closest('[data-gallery-scrolling="true"]'));
      scenes = new Map(
        [...root.querySelectorAll('[data-motion-scene]')].map((scene) => [
          scene,
          [...scene.querySelectorAll<HTMLElement>('[data-motion-step]')].flatMap((target) => {
            const delay = Number(target.dataset.motionStep) * (isChat(scene) ? chatStep : step);
            const bubble = isChat(scene) ? target.querySelector<HTMLElement>('.hs-msg') : null;
            const animations = [
              (bubble ?? target).animate(
                [
                  { opacity: 0, transform: `translateY(${distance}) scale(${bubble ? 0.96 : 1})` },
                  { opacity: 1, transform: 'translateY(0) scale(1)' },
                ],
                { duration, delay, easing, fill: 'both' },
              ),
            ];
            const avatar = bubble && target.querySelector<HTMLElement>('.hs-pic');
            if (avatar)
              animations.push(
                avatar.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, fill: 'both' }),
              );
            const typing = target.querySelector<HTMLElement>('[data-motion-typing]');
            if (typing) {
              const wait = Math.min(delay, chatStep * 0.7);
              const start = delay - wait;
              animations.push(
                typing.animate(
                  [
                    { opacity: 0 },
                    { opacity: 1, offset: 0.08 },
                    { opacity: 1, offset: 0.9 },
                    { opacity: 0 },
                  ],
                  { duration: wait, delay: start, fill: 'both' },
                ),
              );
              for (const [index, dot] of [...typing.children].entries())
                animations.push(
                  dot.animate(
                    [
                      { opacity: 0.35, transform: 'translateY(0)' },
                      { opacity: 1, transform: 'translateY(-2px)' },
                      { opacity: 0.35, transform: 'translateY(0)' },
                    ],
                    {
                      duration: wait / 2,
                      delay: start + (index * wait) / 8,
                      iterations: 2,
                      easing,
                      fill: 'both',
                    },
                  ),
                );
            }
            for (const animation of animations) {
              animation.pause();
              if (isChat(scene) && !centered(scene)) animation.finish();
            }
            return animations;
          }),
        ]),
      );
      const started = new Set<Element>();
      const visible = new Set<Element>();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const animations = scenes.get(entry.target) ?? [];
            const threshold = entry.target.getAttribute('data-motion-scene') === 'beat' ? 0.2 : 0.28;
            if (entry.isIntersecting && entry.intersectionRatio >= threshold)
              visible.add(entry.target);
            else visible.delete(entry.target);
            if (isChat(entry.target) && (!centered(entry.target) || moving(entry.target))) {
              for (const animation of animations) {
                if (moving(entry.target)) animation.pause();
                else animation.finish();
              }
              continue;
            }
            if (
              entry.isIntersecting &&
              !document.hidden &&
              (started.has(entry.target) ||
                entry.intersectionRatio >=
                  (entry.target.getAttribute('data-motion-scene') === 'beat' ? 0.2 : 0.28))
            ) {
              started.add(entry.target);
              for (const animation of animations)
                if (animation.playState !== 'finished') animation.play();
            } else {
              for (const animation of animations)
                if (animation.playState === 'running') animation.pause();
            }
          }
        },
        { threshold: [0, 0.2, 0.28] },
      );
      for (const scene of scenes.keys()) observer.observe(scene);
      const gallery = root.querySelector('[data-chat-gallery]');
      const selectChat = () => {
        for (const [scene, animations] of scenes) {
          if (!isChat(scene)) continue;
          for (const animation of animations) {
            if (moving(scene)) {
              if (centered(scene)) {
                animation.currentTime = 0;
                animation.pause();
                started.delete(scene);
              }
              if (animation.playState === 'running') animation.pause();
            } else if (!centered(scene)) {
              animation.finish();
            } else {
              animation.currentTime = 0;
              animation.pause();
              started.delete(scene);
              if (visible.has(scene) && !document.hidden) {
                started.add(scene);
                animation.play();
              }
            }
          }
        }
      };
      gallery?.addEventListener('hale:gallerychange', selectChat);
      const hero = root.querySelector('[data-motion-scene="hero"]');
      replay.current = () => {
        for (const animation of (hero && scenes.get(hero)) || []) {
          animation.currentTime = 0;
          animation.play();
        }
      };
      const visibility = () => {
        if (document.hidden) {
          for (const animations of scenes.values()) {
            for (const animation of animations)
              if (animation.playState === 'running') animation.pause();
          }
        } else {
          // Re-observing resumes only examples that are still in view.
          for (const scene of scenes.keys()) {
            observer?.unobserve(scene);
            observer?.observe(scene);
          }
        }
      };
      document.addEventListener('visibilitychange', visibility);
      return () => {
        document.removeEventListener('visibilitychange', visibility);
        gallery?.removeEventListener('hale:gallerychange', selectChat);
      };
    };
    let removeVisibility = setup();
    const change = () => {
      removeVisibility?.();
      removeVisibility = setup();
    };
    reduced.addEventListener('change', change);
    return () => {
      removeVisibility?.();
      reduced.removeEventListener('change', change);
      stop();
    };
  }, []);

  return (
    <button
      ref={button}
      type="button"
      className="motion-replay"
      hidden={!enabled}
      onClick={() => replay.current()}
      aria-label={description}
    >
      {label} <span aria-hidden="true">↻</span>
    </button>
  );
}
