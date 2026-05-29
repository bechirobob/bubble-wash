import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bubblewash.co"),
  title: "Bubble Wash — Laundry pickup for busy teams",
  description: "Book laundry pickups, compare plans, estimate delivery fees, track orders, and manage Bubble Wash pilot operations in Accra.",
  applicationName: "Bubble Wash",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
      { url: "/bubble-wash-icon.jpg", type: "image/jpeg", sizes: "1170x1170" },
    ],
    shortcut: "/favicon.png",
    apple: "/apple-icon.png",
  },
  openGraph: {
    title: "Bubble Wash",
    description: "Laundry pickup, subscriptions, vendor fulfilment, and route-based pricing for Accra businesses.",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Bubble Wash icon" }],
  },
  twitter: {
    card: "summary",
    title: "Bubble Wash",
    description: "Laundry pickup, tracking, and support workflows for Accra.",
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#14a8ec",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
