import { BubbleWashOpening } from "@/components/BubbleWashOpening";

/** Persistent across the survey index and questionnaire routes; never keys or resets children. */
export default function SurveyLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <><BubbleWashOpening />{children}</>;
}
