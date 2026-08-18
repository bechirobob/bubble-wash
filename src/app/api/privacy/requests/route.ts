import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createPrivacyRequest, optOutEarlyAccess } from "@/lib/data-store";
import { dispatchPrivacyRequestConfirmation } from "@/lib/notifications";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

const requestTypes = new Set(["access", "correction", "deletion", "marketing_opt_out"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: unknown, maximum = 160) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizedContact(value: string) {
  if (value.includes("@")) return emailPattern.test(value.toLowerCase()) ? value.toLowerCase() : "";
  const digits = value.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  return "";
}

export async function POST(request: NextRequest) {
  const guardError = sameOriginJsonGuard(request.headers, "privacy request");
  if (guardError) return guardError;
  if (isRateLimited(clientKey(request.headers, "privacy-request"), 5, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many privacy requests. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "Invalid privacy request." }, { status: 400 });
    const input = body as Record<string, unknown>;
    if (text(input.website)) return NextResponse.json({ ok: true, message: "Request received." });
    const name = text(input.name, 100);
    const contact = normalizedContact(text(input.contact, 160));
    const orderId = text(input.orderId, 120).toUpperCase();
    const requestType = text(input.requestType, 40);
    if (name.length < 2) return NextResponse.json({ ok: false, error: "Enter your name." }, { status: 400 });
    if (!contact) return NextResponse.json({ ok: false, error: "Enter a valid email address or Ghana phone number." }, { status: 400 });
    if (!requestTypes.has(requestType)) return NextResponse.json({ ok: false, error: "Select a valid request type." }, { status: 400 });
    if (orderId && !/^BW-[A-Z0-9]{8,32}$/.test(orderId)) return NextResponse.json({ ok: false, error: "Enter a valid Bubble Wash order reference or leave it blank." }, { status: 400 });
    const saved = createPrivacyRequest({
      id: `PR-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      requestType: requestType as "access" | "correction" | "deletion" | "marketing_opt_out",
      name,
      contact,
      orderId,
    });
    if (saved.requestType === "marketing_opt_out") optOutEarlyAccess(contact);
    await dispatchPrivacyRequestConfirmation(saved);
    return NextResponse.json({ ok: true, id: saved.id, message: "Your privacy request was received. Keep the reference for follow-up." });
  } catch (error) {
    console.error("Bubble Wash privacy request failed", { message: error instanceof Error ? error.message : "Unknown error" });
    return NextResponse.json({ ok: false, error: "Unable to save the privacy request." }, { status: 500 });
  }
}
