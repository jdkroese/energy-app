import { useEffect, useState } from 'react';

/**
 * Reactive `prefers-reduced-motion` hook. Returns true when the user has asked
 * the OS to reduce motion; updates live if the setting changes. Shared so every
 * animated component honours the same source of truth (also see the global
 * reduced-motion gate in index.css).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduce;
}
