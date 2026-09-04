import { addons } from "./pricing.ts";

export const pickupWindows = ["8:00–10:00", "10:00–12:00", "12:00–14:00", "14:00–16:00", "16:00–18:00"];
export function bookingAvailable(env: Record<string, string | undefined> = process.env) {
  return env.BUBBLEWASH_STAFF_AUTH_DISABLED !== "true" && env.BUBBLEWASH_BOOKINGS_DISABLED !== "true";
}
export function validatePickupSlot(date: string, window: string, now = new Date()) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return "Choose a valid calendar date.";
  if (!pickupWindows.includes(window)) return "Choose a two-hour pickup window.";
  const today = new Date(now.toISOString().slice(0, 10)).getTime();
  if (parsed.getTime() < today || parsed.getTime() > today + 30 * 86400000) return "Choose a pickup within the next 30 days.";
  const start = parsed.getTime() + Number(window.split(":")[0]) * 3600000;
  if (start <= now.getTime()) return "That pickup window has started. Choose a later window.";
  return null;
}
export function validateAddons(value: unknown) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string" || !Object.hasOwn(addons, key)) || new Set(value).size !== value.length) return "Choose valid optional services.";
  if (value.includes("premium") && value.includes("ironing")) return "Premium includes ironing. Choose one service.";
  return null;
}
