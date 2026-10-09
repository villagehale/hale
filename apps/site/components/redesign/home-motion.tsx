'use client';

import { useEffect, useRef } from 'react';

const HERO_HOLD_MS = 3000;
const HERO_RESET_MS = 280;

/** Play the examples. Chats run once; the hero holds, then loops. */
export function HomeMotion() {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = anchor.current?.closest('.rd');
    if (!root || !('IntersectionObserver' in window)) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let observer: IntersectionObserver | undefined;
    let scenes = new Map<Element, Animation[]>();
    let holdTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let holdUntil = 0;
    let holdRemaining = HERO_HOLD_MS;
    let holding = false;
    let resetting = false;
    let heroVisible = false;
    let resetAnims: Animation[] = [];

    const clearHold = () => {
      if (holdTimer) globalThis.clearTimeout(holdTimer);
      holdTimer = undefined;
    };
    const stop = () => {
      observer?.disconnect();
      clearHold();
      holding = false;
      resetting = false;
      heroVisible = false;
      holdRemaining = HERO_HOLD_MS;
      for (const fade of resetAnims) fade.cancel();
      resetAnims = [];
      for (const animations of scenes.values())
        for (const animation of animations) animation.cancel();
      scenes.clear();
    };
    const setup = () => {
      stop();
      if (reduced.matches) return;
      const style = getComputedStyle(root);
      const duration = Number.parseFloat(style.getPropertyValue('--oct-motion-enter-ms'));
      const step = Number.parseFloat(style.getPropertyValue('--oct-motion-step-ms'));
      const chatStep = Number.parseFloat(style.getPropertyValue('--oct-chat-step-ms'));
      const distance = style.getPropertyValue('--oct-motion-distance').trim();
      const easing = style.getPropertyValue('--ease-breathe').trim();
      const sceneOf = (scene: Element) => scene.getAttribute('data-motion-scene');
      const isChat = (scene: Element) => sceneOf(scene) === 'chat';
      const isHero = (scene: Element) => sceneOf(scene) === 'hero';
      const inGallery = (scene: Element) => Boolean(scene.closest('[data-chat-gallery]'));
      const centered = (scene: Element) => Boolean(scene.closest('[data-gallery-active="true"]'));
      const moving = (scene: Element) => Boolean(scene.closest('[data-gallery-scrolling="true"]'));
      const hero = root.querySelector('[data-motion-scene="hero"]');
      const heroAnimations = () => (hero && scenes.get(hero)) || [];
      const heroSettled = () => {
        const animations = heroAnimations();
        return animations.length > 0 && animations.every((animation) => animation.playState === 'finished');
      };
      const beginReset = () => {
        if (resetting || !hero) return;
        resetting = true;
        holding = false;
        clearHold();
        const steps = [...hero.querySelectorAll<HTMLElement>('[data-motion-step]')];
        const fades = steps.map((el) =>
          el.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: HERO_RESET_MS,
            easing,
            fill: 'forwards',
          }),
        );
        resetAnims = fades;
        const replay = () => {
          for (const fade of resetAnims) fade.cancel();
          resetAnims = [];
          resetting = false;
          for (const animation of heroAnimations()) {
            animation.pause();
            animation.currentTime = 0;
          }
          if (heroVisible && !document.hidden)
            for (const animation of heroAnimations()) animation.play();
        };
        if (fades.length === 0) {
          replay();
          return;
        }
        let pending = fades.length;
        for (const fade of fades) {
          fade.onfinish = () => {
            pending -= 1;
            if (pending === 0 && resetting) replay();
          };
        }
      };
      const armHold = () => {
        if (holdTimer || resetting || !holding) return;
        if (!heroVisible || document.hidden) return;
        if (holdRemaining <= 0) {
          beginReset();
          return;
        }
        holdUntil = Date.now() + holdRemaining;
        holdTimer = globalThis.setTimeout(() => {
          holdTimer = undefined;
          holding = false;
          holdRemaining = HERO_HOLD_MS;
          if (!heroVisible || document.hidden) {
            holding = true;
            holdRemaining = 0;
            return;
          }
          beginReset();
        }, holdRemaining);
      };
      const pauseHold = () => {
        if (!holdTimer) return;
        holdRemaining = Math.max(0, holdUntil - Date.now());
        clearHold();
      };
      const scheduleHeroHold = () => {
        if (resetting || !heroSettled()) return;
        if (!holding) {
          holding = true;
          holdRemaining = HERO_HOLD_MS;
        }
        armHold();
      };
      const pauseReset = () => {
        for (const fade of resetAnims) if (fade.playState === 'running') fade.pause();
      };
      const resumeReset = () => {
        if (!heroVisible || document.hidden) return;
        for (const fade of resetAnims) if (fade.playState === 'paused') fade.play();
      };
      scenes = new Map(
        [...root.querySelectorAll('[data-motion-scene]')].map((scene) => [
          scene,
          [...scene.querySelectorAll<HTMLElement>('[data-motion-step]')].flatMap((target) => {
            const delay = Number(target.dataset.motionStep) * (isChat(scene) ? chatStep : step);
            const bubble = target.querySelector<HTMLElement>('.im-b');
            const animations = [
              (bubble ?? target).animate(
                [
                  { opacity: 0, transform: `translateY(${distance}) scale(${bubble ? 0.96 : 1})` },
                  { opacity: 1, transform: 'translateY(0) scale(1)' },
                ],
                { duration, delay, easing, fill: 'both' },
              ),
            ];
            const avatar = bubble && target.querySelector<HTMLElement>('.im-pic');
            if (avatar)
              animations.push(
                avatar.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, fill: 'both' }),
              );
            const name = bubble && target.querySelector<HTMLElement>('.im-who');
            if (name)
              animations.push(
                name.animate([{ opacity: 0 }, { opacity: 1 }], { duration, delay, fill: 'both' }),
              );
            const status = bubble && target.querySelector<HTMLElement>('.im-status');
            if (status)
              animations.push(
                status.animate(
                  [
                    { opacity: 0, transform: `translateY(${distance}) scale(0.96)` },
                    { opacity: 1, transform: 'translateY(0) scale(1)' },
                  ],
                  { duration, delay, easing, fill: 'both' },
                ),
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
              if (isHero(scene)) animation.onfinish = () => scheduleHeroHold();
              if (isChat(scene) && inGallery(scene) && !centered(scene)) animation.finish();
            }
            return animations;
          }),
        ]),
      );
      const started = new Set<Element>();
      const visible = new Set<Element>();
      const thresholdFor = (scene: Element) => (sceneOf(scene) === 'beat' ? 0.2 : 0.28);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const animations = scenes.get(entry.target) ?? [];
            const threshold = thresholdFor(entry.target);
            const shown = entry.isIntersecting && entry.intersectionRatio >= threshold;
            if (shown) visible.add(entry.target);
            else visible.delete(entry.target);
            if (isHero(entry.target)) {
              heroVisible = shown && !document.hidden;
              if (!heroVisible) {
                pauseHold();
                pauseReset();
              }
            }
            if (isChat(entry.target) && inGallery(entry.target) && (!centered(entry.target) || moving(entry.target))) {
              for (const animation of animations) {
                if (moving(entry.target)) animation.pause();
                else animation.finish();
              }
              continue;
            }
            if (
              shown &&
              !document.hidden &&
              (started.has(entry.target) || entry.intersectionRatio >= threshold)
            ) {
              started.add(entry.target);
              for (const animation of animations)
                if (animation.playState !== 'finished') animation.play();
              if (isHero(entry.target)) {
                resumeReset();
                scheduleHeroHold();
              }
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
          if (!isChat(scene) || !inGallery(scene)) continue;
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
      const visibility = () => {
        if (document.hidden) {
          heroVisible = false;
          pauseHold();
          pauseReset();
          for (const animations of scenes.values()) {
            for (const animation of animations)
              if (animation.playState === 'running') animation.pause();
          }
        } else {
          for (const scene of scenes.keys()) {
            observer?.unobserve(scene);
            observer?.observe(scene);
          }
        }
      };
      document.addEventListener('visibilitychange', visibility);
      const layout = matchMedia('(max-width: 767.98px)');
      const onLayout = () => {
        for (const scene of scenes.keys()) {
          observer?.unobserve(scene);
          observer?.observe(scene);
        }
      };
      layout.addEventListener('change', onLayout);
      return () => {
        document.removeEventListener('visibilitychange', visibility);
        gallery?.removeEventListener('hale:gallerychange', selectChat);
        layout.removeEventListener('change', onLayout);
      };
    };
    let removeListeners = setup();
    const change = () => {
      removeListeners?.();
      removeListeners = setup();
    };
    reduced.addEventListener('change', change);
    return () => {
      removeListeners?.();
      reduced.removeEventListener('change', change);
      stop();
    };
  }, []);

  return <div ref={anchor} hidden />;
}
