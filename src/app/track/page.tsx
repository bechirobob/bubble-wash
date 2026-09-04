import type { Metadata } from "next";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";
import { TrackingLookup } from "@/components/TrackingLookup";

export const metadata: Metadata = {
  title: "Track an order | Bubble Wash",
  description: "Check the latest confirmed update for a Bubble Wash order.",
  robots: { index: false, follow: false },
};

export default function TrackPage() {
  return <PublicChrome><PageIntro eyebrow="Order tracking" title="Follow your laundry." summary="Enter your booking reference to see the latest pickup, cleaning and delivery updates." icon="tracking" /><TrackingLookup /></PublicChrome>;
}
