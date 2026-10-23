"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import { shouldShowOpening } from "@/lib/opening-intro";
import styles from "./BubbleWashOpening.module.css";

const playedDocuments = new WeakSet<Document>();
const DURATION_MS = 2050;

/** Home/survey progressive enhancement. Children and answer state are never replaced. */
export function BubbleWashOpening() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof dialog.showModal !== "function") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const eligible = () => shouldShowOpening({
      href: window.location.href,
      navigationHref: navigation?.name,
      navigationType: navigation?.type,
      reducedMotion: motion.matches,
      visible: document.visibilityState === "visible",
      alreadyPlayed: playedDocuments.has(document),
    });
    if (!eligible()) return;

    let deadline: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const finish = () => {
      closed = true;
      clearTimeout(deadline);
      if (dialog.open) dialog.close();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") finish();
    };
    const onMotion = () => { if (motion.matches) finish(); };
    const onCancel = (event: Event) => { event.preventDefault(); finish(); };
    const onPointerDown = (event: PointerEvent) => {
      // Never let dismissal gestures reach the live page behind the modal.
      event.stopPropagation();
    };
    const skip = dialog.querySelector<HTMLButtonElement>("button");
    const logo = dialog.querySelector<HTMLImageElement>("img");
    const onSkip = (event: Event) => { event.stopPropagation(); finish(); };

    // Deferral makes development StrictMode's probe cancel before claiming a document.
    const start = setTimeout(() => {
      if (logo?.complete && logo.naturalWidth === 0) return;
      if (closed || !dialog.isConnected || document.visibilityState !== "visible" || motion.matches) return;
      // If hydration was late and the user already started, do not interrupt their work.
      if (document.activeElement && document.activeElement !== document.body && !dialog.contains(document.activeElement)) return;
      if (window.scrollY > 0 || !eligible()) return;
      try {
        dialog.showModal();
        playedDocuments.add(document);
        deadline = setTimeout(finish, DURATION_MS);
      } catch {
        finish(); // Unsupported/invalid dialog state must never block the page.
      }
    }, 0);

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", finish);
    window.addEventListener("popstate", finish);
    window.addEventListener("hashchange", finish);
    motion.addEventListener("change", onMotion);
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("pointerdown", onPointerDown);
    skip?.addEventListener("click", onSkip);
    logo?.addEventListener("error", finish);
    return () => {
      clearTimeout(start);
      finish();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", finish);
      window.removeEventListener("popstate", finish);
      window.removeEventListener("hashchange", finish);
      motion.removeEventListener("change", onMotion);
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("pointerdown", onPointerDown);
      skip?.removeEventListener("click", onSkip);
      logo?.removeEventListener("error", finish);
    };
  }, []);

  return (
    <dialog ref={dialogRef} className={styles.opening} aria-label="Bubble Wash opening">
      <div className={styles.scene} aria-hidden="true">
        <div className={`${styles.bubble} ${styles.left}`} />
        <div className={`${styles.bubble} ${styles.right}`} />
        <div className={`${styles.bubble} ${styles.merged}`} />
        <div className={styles.ring} />
        <div className={styles.brand}>
          <Image src="/icon-512.png" alt="" width={512} height={512} unoptimized priority draggable={false} />
        </div>
      </div>
      <button type="button" className={styles.skip}>Skip intro</button>
    </dialog>
  );
}
