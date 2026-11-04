import { useEffect, useRef, useState } from "react";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A number that counts up to its value instead of just appearing: 0 -> 14 when
// it first shows, and from the old number to the new one if the value really
// changes. When the value stays the same -- which is what happens on almost
// every 4-5 second refresh -- nothing runs at all.
//
// It's a short requestAnimationFrame loop (about half a second) that only
// touches this one tiny element, so it's cheap on a slow phone. With
// "reduce motion" switched on in the phone's settings the number just shows.
// Screen readers are given the final value straight away, not the counting.
export function CountUp({ value, duration = 500 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const current = useRef(shown);

  useEffect(() => {
    if (reducedMotion() || current.current === value) {
      current.current = value;
      setShown(value);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // quick at first, easing out
      const next = t >= 1 ? value : Math.round(from + (value - from) * eased);
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{value}</span>
    </>
  );
}
