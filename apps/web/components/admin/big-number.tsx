'use client';

import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { useEffect } from 'react';

/** The band's hero numeral: rolls up on arrival; cuts under reduced motion. */
export function BigNumber({ value }: { value: number }) {
  const reduced = useReducedMotion();
  const spring = useSpring(0, { stiffness: 80, damping: 20 });
  const rounded = useTransform(spring, (v) => Math.round(v).toString());

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  if (reduced) return <span className="adm-hero-num">{value}</span>;
  return <motion.span className="adm-hero-num">{rounded}</motion.span>;
}
