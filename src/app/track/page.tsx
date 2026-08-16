import type { Metadata } from "next";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";
import { TrackingLookup } from "@/components/TrackingLookup";

export const metadata: Metadata = {
  title: "Track an order | Bubble Wash",
  description: "Check the latest confirmed update for a Bubble Wash order.",
  robots: { index: false, follow: false },
};

export default function TrackPage() {
  return <PublicChrome><PageIntro eyebrow="Order tracking" title="Check the latest confirmed update." summary="Use the reference issued after booking. Tracking shows service progress without exposing private contact or delivery details." icon="tracking" /><TrackingLookup /></PublicChrome>;
}
