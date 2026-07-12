const MNT = new Intl.NumberFormat("mn-MN", {
  style: "currency",
  currency: "MNT",
  currencyDisplay: "narrowSymbol", // ₮ instead of "MNT"
  maximumFractionDigits: 0,
});

/** Backend Decimal fields serialize as strings — format as tögrög. */
export function formatMNT(amount: string | number): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return Number.isFinite(value) ? MNT.format(value) : "—";
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Full timestamp (datetime strings from the API, e.g. created_at). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
