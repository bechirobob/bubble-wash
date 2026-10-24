"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type WebAppState = {
  available: boolean;
  installed: boolean;
  installing: boolean;
  message: string;
  install: () => Promise<void>;
};

const WebAppContext = createContext<WebAppState>({
  available: false, installed: false, installing: false, message: "", install: async () => {},
});

/** Only the install page shows controls; registration never interrupts a task. */
export function WebAppProvider({ children }: { children: React.ReactNode }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState("");
  const busy = useRef(false);

  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const syncDisplay = () => {
      const standalone = (navigator as Navigator & { standalone?: boolean }).standalone;
      if (display.matches || standalone === true) setInstalled(true);
    };
    const capture = (event: Event) => {
      // Keep the browser prompt for an explicit click on the install page.
      event.preventDefault();
      setPrompt(event as InstallPrompt);
      setMessage("");
    };
    const completed = () => { setInstalled(true); setPrompt(null); setMessage(""); };
    syncDisplay();
    display.addEventListener("change", syncDisplay);
    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", completed);
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        // Browsing and form submission do not depend on service-worker support.
      });
    }
    return () => {
      display.removeEventListener("change", syncDisplay);
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", completed);
    };
  }, []);

  async function install() {
    if (!prompt || busy.current || installed) return;
    busy.current = true;
    setInstalling(true);
    setPrompt(null); // A browser install event can only be used once.
    setMessage("");
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMessage(choice.outcome === "accepted"
        ? "Installation requested. Open Bubble Wash from your home screen when it appears."
        : "You can add Bubble Wash later from your browser menu.");
    } catch {
      setMessage("Installation did not start. Use the steps below instead.");
    } finally {
      busy.current = false;
      setInstalling(false);
    }
  }

  return <WebAppContext.Provider value={{ available: prompt !== null, installed, installing, message, install }}>{children}</WebAppContext.Provider>;
}

export function useWebApp() { return useContext(WebAppContext); }
