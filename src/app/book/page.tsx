import type { Metadata } from "next";
import { BookingExperience } from "@/components/BookingExperience";
import { PageIntro, PublicChrome } from "@/components/PublicChrome";

export const metadata: Metadata = {
  title: "Book a commercial laundry pickup | Bubble Wash",
  description: "Request a Bubble Wash commercial laundry collection in Accra.",
  alternates: { canonical: "/book" },
};

export default function BookPage() {
  return <PublicChrome><PageIntro eyebrow="Book a pickup" title="Give operations the collection details once." summary="Choose the service, business contact, and requested collection window. You receive one reference for every later update." icon="booking" /><BookingExperience /></PublicChrome>;
}
