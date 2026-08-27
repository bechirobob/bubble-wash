"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const corePublicRoutes = ["/", "/services", "/book", "/track", "/manage", "/early-access"] as const;
let hasWarmedPublicRoutes = false;

type NetworkInformation = {
  effectiveType?: string;
  saveData?: boolean;
};

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformation;
};

export function RouteWarmup() {
  const router = useRouter();

  useEffect(() => {
    if (hasWarmedPublicRoutes) return;
    const connection = (navigator as NavigatorWithConnection).connection;
    if (connection?.saveData || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return;

    let cancelled = false;
    const warmRoutes = () => {
      if (cancelled) return;
      hasWarmedPublicRoutes = true;
      corePublicRoutes.forEach((route) => router.prefetch(route));
    };

    const idleWindow = window as Window & typeof globalThis & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (idleWindow.requestIdleCallback) {
      const idleId = idleWindow.requestIdleCallback(warmRoutes, { timeout: 1600 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idleId);
      };
    }

    const timeoutId = window.setTimeout(warmRoutes, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [router]);

  return null;
}
