import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PublicChrome } from "@/components/PublicChrome";
import { WebAppInstall } from "@/components/WebAppInstall";
import styles from "@/components/WebAppInstall.module.css";

export const metadata: Metadata = {
  title: "Add Bubble Wash to your home screen",
  description: "Open Bubble Wash from your phone or computer without an app-store download.",
  alternates: { canonical: "/install" },
};

export default function InstallPage() {
  return <PublicChrome><section className={`pageShell ${styles.page}`} id="main-content" aria-labelledby="install-title">
    <div className={styles.heading}><Image src="/apple-icon.png" width={72} height={72} alt="" unoptimized /><div><h1 id="install-title">Keep Bubble Wash close.</h1><p>Add it to your home screen. No app-store download.</p></div></div>
    <WebAppInstall />
    <Link className={styles.back} href="/">Back to Bubble Wash</Link>
  </section></PublicChrome>;
}
