import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://710ab5d0e640f0.lhr.life"),
  title: "Bubble Wash — Laundry pickup for busy teams",
  description: "Book laundry pickups, compare plans, estimate delivery fees, apply as a vendor, and manage Bubble Wash pilot operations in Accra.",
  icons: {
    icon: "/bubble-wash-icon.jpg",
    shortcut: "/bubble-wash-icon.jpg",
    apple: "/bubble-wash-icon.jpg",
  },
  openGraph: {
    title: "Bubble Wash",
    description: "Laundry pickup, subscriptions, vendor fulfilment, and route-based pricing for Accra businesses.",
    images: ["/bubble-wash-icon.jpg"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
