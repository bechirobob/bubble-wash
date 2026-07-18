import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bubblewash.co"),
  title: "Bubble Wash — Commercial laundry collection in Accra",
  description: "Schedule commercial laundry collection, review transparent service estimates, pay securely, and track each order in Accra.",
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
    description: "Commercial laundry collection, cleaning, delivery, and order tracking for Accra businesses.",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "Bubble Wash icon" }],
  },
  twitter: {
    card: "summary",
    title: "Bubble Wash",
    description: "Commercial laundry collection and order tracking for Accra businesses.",
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#f8fcfd",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
