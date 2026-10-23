export function bookingLabel(value: { bookingReference?: string | null }) {
  const reference = value.bookingReference ?? "";
  const sequence = Number(reference.slice(3));
  return /^BW-[0-9]{3,16}$/.test(reference) && Number.isSafeInteger(sequence) && sequence > 0
    && reference === `BW-${String(sequence).padStart(3, "0")}`
    ? reference : "Legacy test booking";
}
