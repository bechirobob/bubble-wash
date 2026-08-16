import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getCurrentStaffUser } from "@/lib/auth";
import { createBagLabelToken } from "@/lib/chain-of-custody";
import { buildOrderSummaries, orderBoardRecords, orderMatchesStaffEntity, readSubmissionsForOrder } from "@/lib/submissions";

export const runtime = "nodejs";

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character] ?? character));
}

export async function GET(request: NextRequest) {
  const user = await getCurrentStaffUser();
  if (!user || user.role === "support") return NextResponse.json({ ok: false, error: "Order label access requires an operations role." }, { status: 403 });
  const orderId = request.nextUrl.searchParams.get("orderId")?.trim().toUpperCase() ?? "";
  if (!/^BW-[A-Z0-9]{8,32}$/.test(orderId)) return NextResponse.json({ ok: false, error: "Enter a valid order reference." }, { status: 400 });
  const records = await readSubmissionsForOrder(orderId);
  const order = buildOrderSummaries(orderBoardRecords(records, user.role, user.entityId)).find((item) => item.orderId === orderId && orderMatchesStaffEntity(item, user.role, user.entityId));
  if (!order) return NextResponse.json({ ok: false, error: "Order is not available to this role." }, { status: 404 });
  const bagTag = `${order.orderId}-BAG`;
  const token = createBagLabelToken(order.orderId, bagTag);
  const origin = process.env.BUBBLEWASH_PUBLIC_URL || request.nextUrl.origin;
  const scanUrl = `${origin}/scan?token=${encodeURIComponent(token)}`;
  const qr = await QRCode.toDataURL(scanUrl, { errorCorrectionLevel: "M", margin: 1, width: 420, color: { dark: "#123f3a", light: "#ffffff" } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760" viewBox="0 0 600 760"><rect width="600" height="760" rx="28" fill="#fff" stroke="#123f3a" stroke-width="8"/><text x="300" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#123f3a">Bubble Wash</text><text x="300" y="112" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#123f3a">Chain-of-custody bag label</text><image href="${qr}" x="90" y="145" width="420" height="420"/><text x="300" y="620" text-anchor="middle" font-family="monospace" font-size="28" font-weight="700" fill="#123f3a">${escapeXml(bagTag)}</text><text x="300" y="665" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#123f3a">Scan at each handoff · do not remove</text><text x="300" y="705" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#315f59">Label link expires after 30 days</text></svg>`;
  return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="${bagTag}.svg"`, "X-Content-Type-Options": "nosniff" } });
}
