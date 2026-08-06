import { redirect } from "next/navigation";

const earlyAccessUrl = "https://bubblewash-d2c-early-access.mjsdmd.chatgpt.site";

export default function EarlyAccessPage() {
  redirect(earlyAccessUrl);
}
