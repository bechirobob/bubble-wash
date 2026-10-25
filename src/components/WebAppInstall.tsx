"use client";

import { Download } from "lucide-react";
import { useWebApp } from "./WebAppProvider";
import styles from "./WebAppInstall.module.css";

export function WebAppInstall({ staffApp = false }: { staffApp?: boolean }) {
  const appName = staffApp ? "Bubble Wash Staff" : "Bubble Wash";
  const { available, installed, installing, message, install } = useWebApp();
  return (
    <div className={styles.instructions}>
      {installed ? <p role="status">{appName} is installed on this device.</p> : <>
        {(available || installing) && <button className={styles.install} type="button" onClick={() => void install()} disabled={installing}><Download size={18} aria-hidden="true" />{installing ? "Opening install…" : `Install ${appName}`}</button>}
        <p className={styles.status} role="status" aria-live="polite">{message}</p>
        <section aria-labelledby="iphone-install"><h2 id="iphone-install">iPhone or iPad</h2>
          <ol><li>Open {staffApp ? "staff.bubblewash.co" : "bubblewash.co"} in Safari.</li><li>Tap Share, then Add to Home Screen.</li><li>Turn on Open as Web App if shown, then tap Add.</li></ol>
        </section>
        <section aria-labelledby="android-install"><h2 id="android-install">Android</h2>
          <p>Open {appName} in Chrome. Tap Install above if it appears, or open Chrome’s menu, choose Install and create shortcut, then Install. Older versions may say Add to home screen.</p>
        </section>
        <section aria-labelledby="desktop-install"><h2 id="desktop-install">On your computer</h2>
          <p>Look for Install in your browser’s address bar or menu. On a Mac, Safari offers Add to Dock in its File menu.</p>
        </section>
      </>}
      <p className={styles.note}>{staffApp ? "Sign in with your staff account after installation. Work updates need an internet connection. Location sharing may pause when the app is closed or your phone is locked." : "An internet connection is needed for orders and surveys. This web app does not save submissions offline."}</p>
    </div>
  );
}
