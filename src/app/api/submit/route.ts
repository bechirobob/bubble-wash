import { NextRequest } from "next/server";
import { sameOriginJsonGuard } from "@/lib/security";
import { submitForm } from "@/lib/submit-form";

export async function POST(request: NextRequest) {
  const guard = sameOriginJsonGuard(request.headers, "submission");
  if (guard) return guard;
  return submitForm(request);
}
