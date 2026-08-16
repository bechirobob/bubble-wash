import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bubblewash.co"),
  title: "Bubble Wash — Commercial laundry collection in Accra",
  description: "Schedule commercial laundry collection, review transparent service estimates, and track each order in Accra.",
  alternates: { canonical: "/" },
  applicationName: "Bubble Wash",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "32x32" },
      { url: "/apple-icon.png", type: "image/png", sizes: "180x180" },
    ],
    shortcut: "/favicon.png",
    apple: "/apple-icon.png",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Bubble Wash",
    title: "Bubble Wash",
    description: "Commercial laundry collection, cleaning, delivery, and order tracking for Accra businesses.",
    images: [{ url: "/apple-icon.png", width: 180, height: 180, alt: "Bubble Wash icon" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Bubble Wash",
    description: "Commercial laundry collection and order tracking for Accra businesses.",
    images: ["/apple-icon.png"],
  },
  verification: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION ? { google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION } : undefined,
};

export const viewport: Viewport = {
  themeColor: "#f8fcfd",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "LocalBusiness",
        "@id": "https://bubblewash.co/#business",
        name: "Bubble Wash",
        url: "https://bubblewash.co/",
        image: "https://bubblewash.co/apple-icon.png",
        description: "Commercial laundry collection and delivery for businesses in Accra.",
        areaServed: { "@type": "City", name: "Accra" },
        address: { "@type": "PostalAddress", addressLocality: "Accra", addressCountry: "GH" },
        currenciesAccepted: "GHS",
      },
      {
        "@type": "WebSite",
        "@id": "https://bubblewash.co/#website",
        name: "Bubble Wash",
        url: "https://bubblewash.co/",
        publisher: { "@id": "https://bubblewash.co/#business" },
      },
    ],
  };
  return (
    <html lang="en">
      <body><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c") }} />{children}</body>
    </html>
  );
}
