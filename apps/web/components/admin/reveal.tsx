'use client';

import { motion, useReducedMotion } from 'motion/react';

/** 40ms-staggered panel arrival. Reduced motion renders children directly. */
export function Reveal({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3, ease: 'easeOut' }}
      style={{ minWidth: 0 }}
    >
      {children}
    </motion.div>
  );
}
