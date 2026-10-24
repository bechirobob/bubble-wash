/** Opaque relationship/tracking identity, separate from sequential display labels. */
export function submissionIdentity(uuid: string) {
  const hex = uuid.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error("Invalid submission identity entropy.");
  return `BW-R${hex.slice(0, 16).toUpperCase()}`;
}
