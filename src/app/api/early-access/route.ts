import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { upsertEarlyAccessSignup } from "@/lib/data-store";
import { dispatchEarlyAccessConfirmation } from "@/lib/notifications";
import { clientKey, isRateLimited } from "@/lib/rate-limit";
import { sameOriginJsonGuard } from "@/lib/security";

const areas = new Set([
  "Osu", "Labone", "Cantonments", "Airport Residential", "East Legon", "Dzorwulu",
  "Ridge", "Adabraka", "Spintex", "Tema", "Another Accra area",
]);
const frequencies = new Set(["Weekly", "Twice a month", "When needed"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const consentVersion = "early-access-2026-08-16";

function text(value: unknown, maximum = 160) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeGhanaPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  return "";
}

export async function POST(request: NextRequest) {
  const guardError = sameOriginJsonGuard(request.headers, "early-access signup");
  if (guardError) return guardError;
  if (await isRateLimited(clientKey(request.headers, "early-access"), 8, 60_000)) {
    return NextResponse.json({ ok: false, error: "Too many signup attempts. Try again shortly." }, { status: 429 });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ ok: false, error: "Invalid signup request." }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (text(input.website)) return NextResponse.json({ ok: true, message: "Request received." });
    const firstName = text(input.firstName, 60);
    const phone = normalizeGhanaPhone(text(input.phone, 40));
    const email = text(input.email, 120).toLowerCase();
    const area = text(input.area, 80);
    const frequency = text(input.frequency, 40);
    if (firstName.length < 2) return NextResponse.json({ ok: false, error: "Enter your first name." }, { status: 400 });
    if (!phone) return NextResponse.json({ ok: false, error: "Enter a valid Ghana WhatsApp number." }, { status: 400 });
    if (email && !emailPattern.test(email)) return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
    if (!areas.has(area)) return NextResponse.json({ ok: false, error: "Select a valid collection area." }, { status: 400 });
    if (!frequencies.has(frequency)) return NextResponse.json({ ok: false, error: "Select a valid laundry frequency." }, { status: 400 });
    if (input.consent !== true) return NextResponse.json({ ok: false, error: "Consent is required before we can send launch updates." }, { status: 400 });

    const saved = await upsertEarlyAccessSignup({
      id: `EA-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`,
      firstName, phone, email, area, frequency,
      consentAt: new Date().toISOString(),
      consentVersion,
    });
    const notifications = await dispatchEarlyAccessConfirmation(saved.signup);
    return NextResponse.json({
      ok: true,
      updated: saved.updated,
      message: saved.updated ? "Your early-access details were updated." : "You are on the Bubble Wash early-access list.",
      confirmation: {
        whatsapp: notifications.find((item) => item.channel === "whatsapp")?.sent ? "sent" : "queued",
        email: email ? (notifications.find((item) => item.channel === "email")?.sent ? "sent" : "queued") : "not_requested",
      },
    });
  } catch (error) {
    console.error("Bubble Wash early-access signup failed", { message: error instanceof Error ? error.message : "Unknown error" });
    return NextResponse.json({ ok: false, error: "Unable to save your early-access request." }, { status: 500 });
  }
}
