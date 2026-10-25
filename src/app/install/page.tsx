import type { Metadata } from "next";
import { headers } from "next/headers";
import { isStaffAppHost, STAFF_APP_URL } from "@/lib/web-app";
import Image from "next/image";
import Link from "next/link";
import { PublicChrome } from "@/components/PublicChrome";
import { WebAppInstall } from "@/components/WebAppInstall";
import styles from "@/components/WebAppInstall.module.css";

const customerMetadata: Metadata = {
  title: "Add Bubble Wash to your home screen",
  description: "Open Bubble Wash from your phone or computer without an app-store download.",
  alternates: { canonical: "/install" },
};

export async function generateMetadata(): Promise<Metadata> {
  return isStaffAppHost((await headers()).get("host"))
    ? { title: "Add Bubble Wash Staff to your home screen", description: "Your staff workspace, one tap away." }
    : customerMetadata;
}

export default async function InstallPage() {
  if (isStaffAppHost((await headers()).get("host"))) return (
    <main className={`pageShell ${styles.page}`} aria-labelledby="install-title">
      <div className={styles.heading}><Image src="/staff-icon-192.png" width={72} height={72} alt="" /><div><h1 id="install-title">Bubble Wash Staff</h1><p>Your workspace, one tap away.</p></div></div>
      <WebAppInstall staffApp />
      <Link className={styles.back} href="/staff">Back to staff sign-in</Link>
    </main>
  );
  return <PublicChrome><section className={`pageShell ${styles.page}`} id="main-content" aria-labelledby="install-title">
    <div className={styles.heading}><span className={styles.brand} aria-hidden="true"><Image src="/bubble-wash-icon.jpg" width={166} height={166} alt="" unoptimized /></span><div><h1 id="install-title">Keep Bubble Wash close.</h1><p>Add it to your home screen. No app-store download.</p></div></div>
    <WebAppInstall />
    <Link className={styles.back} href="/">Back to Bubble Wash</Link>
    <p>Working with Bubble Wash? <a href={`${STAFF_APP_URL}/install`}>Add the staff app</a>.</p>
  </section></PublicChrome>;
}
