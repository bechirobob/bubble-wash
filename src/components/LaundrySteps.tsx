"use client";

import { useEffect, useRef } from "react";

const steps = [
  ["Pickup", "Choose a time. We confirm it and collect your laundry."],
  ["Cleaning", "Your laundry is checked, weighed, cleaned and finished."],
  ["Return", "Track your order and share your code when it arrives."],
];

export function LaundrySteps() {
  const root = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const node = root.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    node.classList.add("motionArmed");
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        node.classList.add("motionPlayed"); observer.disconnect();
      }
    }, { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <ol className="laundrySteps" ref={root}>{steps.map(([title, copy], i) => <li key={title}><span className="stepIndex">0{i + 1}</span><div><h3>{title}</h3><p>{copy}</p></div></li>)}</ol>;
}
