export type Quote = {
  plan: string;
  pickupRhythm: string;
  kg: number;
  zone: string;
  zoneFee: number;
  discount: string;
  discountAmount: number;
  ratePerKg: number;
  subscription: number;
  monthlyPickups: number;
  processingPerPickup: number;
  addonsPerPickup: number;
  addonLines: Array<{ key: string; label: string; amount: number }>;
  perPickupTotal: number;
  grossMonthlyTotal: number;
  estimatedMonthlyTotal: number;
  minimumApplied: boolean;
};

export function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

export function formatDate(value?: string) {
  if (!value) return "Not updated yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" });
}

export function statusTone(message?: string) {
  if (!message) return "status";
  if (/no .*found|unavailable|paused|cannot|expired|choose |unable|failed|missing|invalid|too many|error|required|not configured|enter .*first|did not match/i.test(message)) return "status error";
  if (/waiting|pending|delayed|attention|warning|overdue/i.test(message)) return "status warning";
  if (/ready|covered|received|reference|selected|loaded|verified|paid|saved|found/i.test(message)) return "status success";
  if (/loading|checking|saving|updating|opening|starting|stopping|calculating|verifying/i.test(message)) return "status info";
  return "status";
}

export async function postJSON<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
